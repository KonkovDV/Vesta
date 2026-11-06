import { getRawEnv } from './index';

/**
 * Product domains that still live in this tree (ADR-0005). ADR-0003 places each
 * in its own product repository. Until one moves, a deployment turns it on with
 * MODULE_<NAME>_ENABLED=true; unset, the kernel registers none of its services,
 * starts none of its workers, and mounts none of its routes.
 */
export const PRODUCT_DOMAINS = ['sales', 'hr', 'healthcare', 'research', 'x402'] as const;

export type ProductDomain = (typeof PRODUCT_DOMAINS)[number];

const FLAGS: Record<ProductDomain, string> = {
  sales: 'MODULE_SALES_ENABLED',
  hr: 'MODULE_HR_ENABLED',
  healthcare: 'MODULE_HEALTHCARE_ENABLED',
  research: 'MODULE_RESEARCH_ENABLED',
  x402: 'MODULE_X402_ENABLED',
};

export function productDomainFlag(domain: ProductDomain): string {
  return FLAGS[domain];
}

/** True only for `true` or `1`. Any other value, or none, leaves the domain off. */
export function productDomainEnabled(domain: ProductDomain): boolean {
  const value = (getRawEnv()[FLAGS[domain]] ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}
