import { KeycloakTokenResponse } from './types';

const TOKEN_URL = 'https://sso.pjn.gov.ar/auth/realms/pjn/protocol/openid-connect/token';
const SAFETY_MARGIN_MS = 30_000;

export interface KeycloakClientOptions {
  clientId: string;
  refreshToken: string;
}

export class KeycloakClient {
  private clientId: string;
  private refreshToken: string;
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(opts: KeycloakClientOptions) {
    this.clientId = opts.clientId;
    this.refreshToken = opts.refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt - SAFETY_MARGIN_MS) {
      return this.accessToken;
    }
    return this.refresh();
  }

  async refresh(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      refresh_token: this.refreshToken,
    });

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Keycloak refresh failed (${res.status}): ${text}`);
    }

    const json = (await res.json()) as KeycloakTokenResponse;
    this.accessToken = json.access_token;
    this.accessTokenExpiresAt = Date.now() + json.expires_in * 1000;
    if (json.refresh_token) {
      this.refreshToken = json.refresh_token;
    }
    return this.accessToken;
  }

  getCurrentRefreshToken(): string {
    return this.refreshToken;
  }
}
