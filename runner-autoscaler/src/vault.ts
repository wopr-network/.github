// Minimal HTTP client for vault.wopr.bot.
// Uses node's built-in fetch (Node 18+). No node-vault dep.
//
// AppRole login → token → KV v2 reads. Holds the token in memory and
// re-logs-in on 403 (token expired or revoked).

import { log } from "./log.js";

interface VaultLoginResponse {
  auth: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
  };
}

interface VaultKVResponse {
  data: {
    data: Record<string, string>;
    metadata: {
      version: number;
      created_time: string;
    };
  };
}

export class VaultClient {
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly addr: string,
    private readonly roleId: string,
    private readonly secretId: string,
  ) {}

  async login(): Promise<void> {
    const url = `${this.addr}/v1/auth/approle/login`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_id: this.roleId, secret_id: this.secretId }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Vault AppRole login failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as VaultLoginResponse;
    this.token = json.auth.client_token;
    // Renew before half the lease is up. Lease in seconds.
    this.tokenExpiresAt = Date.now() + json.auth.lease_duration * 500;
    log.info({ lease_duration_s: json.auth.lease_duration, renewable: json.auth.renewable }, "vault login ok");
  }

  async readKV(path: string): Promise<Record<string, string>> {
    if (!this.token || Date.now() > this.tokenExpiresAt) {
      await this.login();
    }
    const url = `${this.addr}/v1/secret/data/${path}`;
    const res = await fetch(url, {
      headers: { "X-Vault-Token": this.token ?? "" },
    });
    if (res.status === 403) {
      // Token expired or got revoked between login and now. One re-login retry.
      log.warn("vault read got 403, re-logging in");
      await this.login();
      const retry = await fetch(url, {
        headers: { "X-Vault-Token": this.token ?? "" },
      });
      if (!retry.ok) {
        throw new Error(`Vault read failed after relogin: ${retry.status}`);
      }
      return ((await retry.json()) as VaultKVResponse).data.data;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Vault read failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as VaultKVResponse;
    return json.data.data;
  }

  /**
   * Read a single field from a KV path. Throws if the path or field is missing.
   * Use this for boot-time fetches where the field MUST exist.
   */
  async readField(path: string, field: string): Promise<string> {
    const data = await this.readKV(path);
    const value = data[field];
    if (value === undefined || value === "") {
      throw new Error(`Vault path ${path} missing required field: ${field}`);
    }
    return value;
  }
}
