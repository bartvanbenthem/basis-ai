import { Switch, TextField } from '@backstage/ui';
import type { ExposeFields as Expose } from './expose';

/**
 * The expose switch and its fields, for a gateway (hostname, HTTPS) or a
 * database (hostname: false; TLS from the database itself).
 */
export const ExposeFields = ({
  value,
  onChange,
  errors,
  hostname = true,
  label,
  hint,
}: {
  value: Expose;
  onChange: (value: Expose) => void;
  errors: { hostname?: string; sourceRanges?: string };
  hostname?: boolean;
  label: string;
  /** Under the CIDRs, when they have no error. */
  hint: string;
}) => {
  const set = <K extends keyof Expose>(key: K) => (v: Expose[K]) => onChange({ ...value, [key]: v });
  return (
    <>
      <Switch label={label} isSelected={value.enabled} onChange={set('enabled')} />
      {value.enabled && hostname && (
        <TextField
          label="Hostname"
          isRequired
          value={value.hostname}
          onChange={set('hostname')}
          placeholder="llm.example.com"
          description={
            errors.hostname ??
            'Clients call https://<hostname>/v1. The certificate is for it (cert-manager); its DNS record, pointing at the load balancer address, is yours.'
          }
          isInvalid={Boolean(errors.hostname)}
        />
      )}
      {value.enabled && (
        <TextField
          label="Allowed client CIDRs"
          isRequired
          value={value.sourceRanges}
          onChange={set('sourceRanges')}
          placeholder="203.0.113.0/24, 10.0.0.0/8"
          description={errors.sourceRanges ?? hint}
          isInvalid={Boolean(errors.sourceRanges)}
        />
      )}
    </>
  );
};
