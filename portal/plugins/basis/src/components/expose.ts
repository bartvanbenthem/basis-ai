/**
 * The expose fields the gateway and stack forms share: a ModelGateway's
 * spec.expose (HTTPS at a hostname, on a LoadBalancer of its own) and a
 * database's (a LoadBalancer with TLS). Settings the form doesn't show
 * (issuer, annotations) are kept as they are.
 */

import type { GatewayExpose } from '@internal/backstage-plugin-basis-common';
import { CIDR, sourceRanges } from './form';

export interface ExposeFields {
  enabled: boolean;
  /** The gateway's DNS name; unused for a database. */
  hostname: string;
  /** CIDRs, comma or newline separated; required when exposed. */
  sourceRanges: string;
  /** What the form doesn't show, sent back unchanged. */
  rest: Record<string, unknown>;
}

export const defaultExpose = (): ExposeFields => ({ enabled: false, hostname: '', sourceRanges: '', rest: {} });

export function fromExpose(e?: GatewayExpose): ExposeFields {
  const { enabled, hostname, loadBalancerSourceRanges, ...rest } = e ?? {};
  return {
    enabled: Boolean(enabled),
    hostname: hostname ?? '',
    sourceRanges: (loadBalancerSourceRanges ?? []).join(', '),
    rest,
  };
}

const HOSTNAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)+$/;

/** Errors by field (hostname, sourceRanges); mirrors the XRD's rules. */
export function validateExpose(f: ExposeFields, { hostname = true } = {}): Partial<Record<'hostname' | 'sourceRanges', string>> {
  const e: Partial<Record<'hostname' | 'sourceRanges', string>> = {};
  if (!f.enabled) return e;
  if (hostname && (f.hostname.length > 253 || !HOSTNAME.test(f.hostname))) {
    e.hostname = 'A DNS name in lowercase, e.g. llm.example.com.';
  }
  const ranges = sourceRanges(f.sourceRanges);
  if (!ranges.length) e.sourceRanges = 'The client CIDRs that may connect, e.g. 203.0.113.0/24 (0.0.0.0/0 for everyone).';
  else if (ranges.some(r => !CIDR.test(r))) e.sourceRanges = 'CIDRs like 10.0.0.0/8, separated by commas.';
  return e;
}

/** spec.expose, only when exposed: internal is the XRD default, and an edit that turns it off removes it. */
export function toExpose(f: ExposeFields, { hostname = true } = {}): Record<string, unknown> | undefined {
  if (!f.enabled) return undefined;
  return {
    ...f.rest,
    enabled: true,
    ...(hostname ? { hostname: f.hostname.trim() } : {}),
    loadBalancerSourceRanges: sourceRanges(f.sourceRanges),
  };
}
