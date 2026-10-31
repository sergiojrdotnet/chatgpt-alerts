import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { equal } from './model.ts';
import type { Config } from './config.ts';
import type { Principal } from './model.ts';

export function authentication(config: Config, keys?: JWTVerifyGetKey) {
  const issuer = `https://${config.CF_ACCESS_TEAM_DOMAIN}`;
  const jwks = keys ?? (!config.DEV_TOKEN ? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) : undefined);
  function authorized(owner: string) {
    if (config.DEV_TOKEN) return owner === 'development';
    try {
      const [iss, sub, email] = JSON.parse(owner);
      return iss === issuer && typeof sub === 'string' && sub.length > 0 && config.emails.has(email);
    } catch { return false; }
  }
  return {
    authorized,
    async authenticate(headers: Record<string, string | string[] | undefined>): Promise<Principal | undefined> {
      if (config.DEV_TOKEN) return equal(String(headers.authorization ?? ''), `Bearer ${config.DEV_TOKEN}`) ? { id: 'development', expiresAt: Date.now() + 3600000 } : undefined;
      const assertion = headers['cf-access-jwt-assertion'];
      if (typeof assertion !== 'string') return undefined;
      try {
        const { payload } = await jwtVerify(assertion, jwks!, { issuer, audience: config.CF_ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['sub', 'exp', 'iat'] });
        if (payload.type !== 'app' || typeof payload.email !== 'string' || !payload.sub || !config.emails.has(payload.email.toLowerCase())) return undefined;
        return { id: JSON.stringify([issuer, payload.sub, payload.email.toLowerCase()]), expiresAt: payload.exp! * 1000 };
      } catch { return undefined; }
    }
  };
}
