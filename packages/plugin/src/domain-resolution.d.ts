export type LoopbackDomain = "localtest.me" | "lvh.me" | "nip.io";

export interface CaddyTlsDomainOptions {
  domain?: string | string[];
  baseDomain?: string;
  loopbackDomain?: LoopbackDomain;
  repo?: string;
  branch?: string;
  instanceLabel?: string;
}

export declare const LOOPBACK_DOMAINS: Record<LoopbackDomain, string>;

export declare function getGitRepoInfo(): {
  repo?: string;
  branch?: string;
};

export declare function normalizeBaseDomain(baseDomain: string): string;
export declare function resolveBaseDomain(options: CaddyTlsDomainOptions): string;
export declare function normalizeDomain(domain: string): string | null;
export declare function normalizeDomains(domains: string | string[]): string[] | null;
export declare function sanitizeDomainLabel(value: string): string;
export declare function compactDomainLabel(value: string): string;
export declare function buildDerivedDomain(options: CaddyTlsDomainOptions): string | null;
export declare function resolveCaddyTlsDomains(options?: CaddyTlsDomainOptions): string[] | null;
export declare function resolveCaddyTlsUrl(options?: CaddyTlsDomainOptions): string | null;
