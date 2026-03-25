import crypto from "node:crypto";
import { URLSearchParams } from "node:url";
import { SignJWT, jwtVerify } from "jose";
export class RedmineOAuthProxy {
    config;
    pendingAuth = new Map();
    sessions = new Map();
    oauthCodes = new Map();
    refreshTokens = new Map();
    jwtSecretBytes;
    constructor(config) {
        this.config = config;
        this.jwtSecretBytes = new TextEncoder().encode(config.jwtSecret);
    }
    register(app) {
        app.get("/.well-known/oauth-authorization-server", (_req, res) => {
            res.json({
                issuer: this.config.baseUrl,
                authorization_endpoint: `${this.config.baseUrl}/auth/authorize`,
                token_endpoint: `${this.config.baseUrl}/auth/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                token_endpoint_auth_methods_supported: ["none"],
                code_challenge_methods_supported: ["S256"]
            });
        });
        app.get("/auth/authorize", (req, res) => this.handleAuthorize(req, res));
        app.get("/auth/callback", (req, res) => void this.handleCallback(req, res));
        app.post("/auth/token", (req, res) => void this.handleToken(req, res));
    }
    async authenticateFromHeader(authorizationHeader) {
        if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
            return null;
        }
        const token = authorizationHeader.slice("Bearer ".length).trim();
        try {
            const verified = await jwtVerify(token, this.jwtSecretBytes, {
                issuer: this.config.baseUrl
            });
            const payload = verified.payload;
            const sessionId = String(payload.sid ?? "");
            if (!sessionId) {
                return null;
            }
            const session = this.sessions.get(sessionId);
            if (!session) {
                return null;
            }
            const refreshed = await this.ensureFreshRedmineToken(session);
            return {
                sessionId: refreshed.id,
                redmineAccessToken: refreshed.redmineAccessToken,
                scopes: refreshed.scopes
            };
        }
        catch {
            return null;
        }
    }
    handleAuthorize(req, res) {
        const responseType = String(req.query.response_type ?? "code");
        const clientId = String(req.query.client_id ?? "");
        const redirectUri = String(req.query.redirect_uri ?? "");
        const state = String(req.query.state ?? "");
        const codeChallenge = req.query.code_challenge ? String(req.query.code_challenge) : undefined;
        const codeChallengeMethod = req.query.code_challenge_method ? String(req.query.code_challenge_method) : undefined;
        if (responseType !== "code" || !clientId || !redirectUri) {
            res.status(400).json({ error: "invalid_request", error_description: "Missing OAuth authorization parameters." });
            return;
        }
        const reqId = crypto.randomUUID();
        this.pendingAuth.set(reqId, {
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod
        });
        const scopes = this.config.getEffectiveScopes().join(" ");
        const callbackUrl = `${this.config.baseUrl}/auth/callback`;
        const redmineAuthorize = new URL(`${this.config.redmineUrl}/oauth/authorize`);
        redmineAuthorize.searchParams.set("response_type", "code");
        redmineAuthorize.searchParams.set("client_id", this.config.redmineClientId);
        redmineAuthorize.searchParams.set("redirect_uri", callbackUrl);
        if (scopes) {
            redmineAuthorize.searchParams.set("scope", scopes);
        }
        redmineAuthorize.searchParams.set("state", reqId);
        res.redirect(302, redmineAuthorize.toString());
    }
    async handleCallback(req, res) {
        const requestId = String(req.query.state ?? "");
        const code = String(req.query.code ?? "");
        const error = String(req.query.error ?? "");
        const pending = this.pendingAuth.get(requestId);
        if (!pending) {
            res.status(400).send("Invalid OAuth state.");
            return;
        }
        this.pendingAuth.delete(requestId);
        if (error) {
            const failure = new URL(pending.redirectUri);
            failure.searchParams.set("error", error);
            if (pending.state)
                failure.searchParams.set("state", pending.state);
            res.redirect(302, failure.toString());
            return;
        }
        if (!code) {
            res.status(400).send("Missing authorization code.");
            return;
        }
        const callbackUrl = `${this.config.baseUrl}/auth/callback`;
        const tokenResult = await this.exchangeWithRedmine({
            grantType: "authorization_code",
            code,
            redirectUri: callbackUrl
        });
        const sessionId = crypto.randomUUID();
        const scopeList = tokenResult.scope ? tokenResult.scope.split(" ").filter(Boolean) : this.config.getEffectiveScopes();
        const session = {
            id: sessionId,
            redmineAccessToken: tokenResult.access_token,
            redmineRefreshToken: tokenResult.refresh_token,
            redmineExpiresAt: tokenResult.expires_in ? Date.now() + Number(tokenResult.expires_in) * 1000 : undefined,
            scopes: scopeList
        };
        this.sessions.set(sessionId, session);
        const mcpAuthCode = crypto.randomUUID();
        this.oauthCodes.set(mcpAuthCode, {
            sessionId,
            clientId: pending.clientId,
            redirectUri: pending.redirectUri,
            expiresAt: Date.now() + 5 * 60_000,
            codeChallenge: pending.codeChallenge,
            codeChallengeMethod: pending.codeChallengeMethod
        });
        const success = new URL(pending.redirectUri);
        success.searchParams.set("code", mcpAuthCode);
        if (pending.state)
            success.searchParams.set("state", pending.state);
        res.redirect(302, success.toString());
    }
    async handleToken(req, res) {
        const grantType = String((req.body?.grant_type ?? req.query.grant_type ?? "").toString());
        if (grantType === "authorization_code") {
            const code = String(req.body?.code ?? "");
            const clientId = String(req.body?.client_id ?? "");
            const redirectUri = String(req.body?.redirect_uri ?? "");
            const codeVerifier = req.body?.code_verifier ? String(req.body.code_verifier) : undefined;
            const stored = this.oauthCodes.get(code);
            if (!stored || stored.expiresAt < Date.now()) {
                res.status(400).json({ error: "invalid_grant" });
                return;
            }
            if (stored.clientId !== clientId || stored.redirectUri !== redirectUri) {
                res.status(400).json({ error: "invalid_grant" });
                return;
            }
            if (!this.verifyPkce(stored.codeChallenge, stored.codeChallengeMethod, codeVerifier)) {
                res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
                return;
            }
            this.oauthCodes.delete(code);
            const session = this.sessions.get(stored.sessionId);
            if (!session) {
                res.status(400).json({ error: "invalid_grant" });
                return;
            }
            const accessToken = await this.issueJwt(session);
            const refreshToken = crypto.randomUUID();
            this.refreshTokens.set(refreshToken, { sessionId: session.id, expiresAt: Date.now() + 30 * 24 * 60 * 60_000 });
            res.json({
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: this.config.jwtTtlSeconds,
                refresh_token: refreshToken,
                scope: session.scopes.join(" ")
            });
            return;
        }
        if (grantType === "refresh_token") {
            const refreshToken = String(req.body?.refresh_token ?? "");
            const refresh = this.refreshTokens.get(refreshToken);
            if (!refresh || refresh.expiresAt < Date.now()) {
                res.status(400).json({ error: "invalid_grant" });
                return;
            }
            const session = this.sessions.get(refresh.sessionId);
            if (!session) {
                res.status(400).json({ error: "invalid_grant" });
                return;
            }
            const refreshed = await this.ensureFreshRedmineToken(session);
            const accessToken = await this.issueJwt(refreshed);
            res.json({
                access_token: accessToken,
                token_type: "Bearer",
                expires_in: this.config.jwtTtlSeconds,
                scope: refreshed.scopes.join(" ")
            });
            return;
        }
        res.status(400).json({ error: "unsupported_grant_type" });
    }
    verifyPkce(codeChallenge, codeChallengeMethod, codeVerifier) {
        if (!codeChallenge)
            return true;
        if (!codeVerifier)
            return false;
        if (!codeChallengeMethod || codeChallengeMethod === "plain") {
            return codeChallenge === codeVerifier;
        }
        if (codeChallengeMethod === "S256") {
            const hash = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
            return hash === codeChallenge;
        }
        return false;
    }
    async issueJwt(session) {
        return new SignJWT({
            sid: session.id,
            scopes: session.scopes
        })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuer(this.config.baseUrl)
            .setSubject(session.userSub ?? session.id)
            .setIssuedAt()
            .setExpirationTime(`${this.config.jwtTtlSeconds}s`)
            .sign(this.jwtSecretBytes);
    }
    async ensureFreshRedmineToken(session) {
        const exp = session.redmineExpiresAt;
        const aboutToExpire = exp !== undefined && exp - Date.now() < 30_000;
        if (!aboutToExpire) {
            return session;
        }
        if (!session.redmineRefreshToken) {
            return session;
        }
        const refreshed = await this.exchangeWithRedmine({
            grantType: "refresh_token",
            refreshToken: session.redmineRefreshToken
        });
        session.redmineAccessToken = refreshed.access_token;
        session.redmineRefreshToken = refreshed.refresh_token ?? session.redmineRefreshToken;
        session.redmineExpiresAt = refreshed.expires_in ? Date.now() + Number(refreshed.expires_in) * 1000 : undefined;
        if (refreshed.scope) {
            session.scopes = refreshed.scope.split(" ").filter(Boolean);
        }
        this.sessions.set(session.id, session);
        return session;
    }
    async exchangeWithRedmine(args) {
        const body = new URLSearchParams({
            grant_type: args.grantType,
            client_id: this.config.redmineClientId,
            client_secret: this.config.redmineClientSecret
        });
        if (args.code)
            body.set("code", args.code);
        if (args.redirectUri)
            body.set("redirect_uri", args.redirectUri);
        if (args.refreshToken)
            body.set("refresh_token", args.refreshToken);
        const response = await fetch(`${this.config.redmineUrl}/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
        });
        if (!response.ok) {
            throw new Error(`Redmine token exchange failed with status ${response.status}`);
        }
        return (await response.json());
    }
}
