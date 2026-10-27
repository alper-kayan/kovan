/**
 * Commands whose effect reaches beyond this machine (a push, a deploy, a publish, a migration).
 * If one is cut off mid-flight nobody knows whether it happened, so it is never retried
 * automatically; a person records the outcome.
 */
const RISKY =
  /\b(git\s+push|deploy|publish|release|kubectl|terraform|helm|docker\s+push|vercel|netlify|flyctl|fly\s+deploy|heroku|aws\s|gcloud\s|az\s|scp\s|rsync\s|psql\s|mysql\s|migrate|curl\s[^|]*-X\s*(POST|PUT|PATCH|DELETE))/i;

export function isRiskyCommand(command: string): boolean {
  return RISKY.test(command);
}

/** Errors that mean the account ran out (credits, quota, rate or usage limits). */
const LIMIT =
  /(usage limit|hit your (?:\w+ )?limit|rate[ -]?limit|quota|insufficient (credits|funds|balance)|credit balance|out of credits|exceeded your current|limit reached|usageLimitExceeded|\b402\b|\b429\b)/i;

export function isUsageLimit(error: string): boolean {
  return LIMIT.test(error);
}
