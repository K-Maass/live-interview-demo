import * as oidc from "openid-client";
import { fail } from "./errors.mjs";
export class OidcIdentity {
  constructor(config, { fetch: fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
  }
  async client() {
    if (!this.config.authConfigured) fail(503, "authNotConfigured");
    if (!this.pending)
      this.pending = oidc
        .discovery(
          new URL(this.config.oidc.issuer),
          this.config.oidc.clientId,
          {
            client_secret: this.config.oidc.clientSecret,
            redirect_uris: [`${this.config.origin}/auth/callback`],
            response_types: ["code"],
            id_token_signed_response_alg: "RS256",
          },
          oidc.ClientSecretPost(this.config.oidc.clientSecret),
          {
            timeout: 10,
            [oidc.customFetch]: this.fetch,
            execute: [oidc.enableNonRepudiationChecks],
          },
        )
        .catch((e) => {
          this.pending = undefined;
          throw e;
        });
    return this.pending;
  }
  async authorizationUrl(flow) {
    const client = await this.client();
    return oidc
      .buildAuthorizationUrl(client, {
        redirect_uri: `${this.config.origin}/auth/callback`,
        scope: "openid email profile",
        response_type: "code",
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: "S256",
        state: flow.state,
        nonce: flow.nonce,
      })
      .toString();
  }
  async authenticate(url, flow) {
    const client = await this.client();
    const tokens = await oidc.authorizationCodeGrant(client, url, {
      pkceCodeVerifier: flow.verifier,
      expectedState: flow.state,
      expectedNonce: flow.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (
      !claims ||
      claims.iss !== this.config.oidc.issuer ||
      typeof claims.sub !== "string" ||
      !claims.sub ||
      claims.sub.length > 500
    )
      fail(400, "invalidIdentity");
    const identity = { issuer: claims.iss, subject: claims.sub };
    if (
      claims.email_verified === true &&
      typeof claims.email === "string" &&
      claims.email.length <= 320
    )
      identity.email = claims.email;
    if (typeof claims.name === "string" && claims.name.length <= 200)
      identity.name = claims.name;
    return identity;
  }
}
