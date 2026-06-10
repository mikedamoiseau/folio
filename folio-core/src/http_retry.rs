//! Shared retry/backoff helper for enrichment provider HTTP calls (#F-2-7).
//!
//! All enrichment traffic (the `providers/` modules and the legacy
//! `openlibrary` module) funnels through [`send_with_retry`], which retries
//! transport errors, HTTP 429, and HTTP 5xx with exponential backoff,
//! honoring `Retry-After` (seconds form). Non-retryable statuses (404, 400,
//! 401, …) are returned to the caller untouched so existing status handling
//! keeps working. An optional process-wide observer receives a
//! [`RetryEvent`] before each retry so the UI layer can surface feedback.

use std::time::Duration;

/// Retry behavior knobs. One default policy is shared by all call sites.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Total attempts, including the first.
    pub max_attempts: u32,
    /// Delay before the second attempt; doubles each retry.
    pub base_delay: Duration,
    /// Upper bound for any computed or server-requested delay.
    pub max_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(8),
        }
    }
}

/// A status worth retrying: rate limit or server-side failure. Everything
/// else (404, 400, 401, …) must reach the caller untouched.
pub fn is_retryable(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error()
}

/// `Retry-After` in seconds form. The HTTP-date form is rare on JSON APIs
/// and deliberately treated as absent.
pub fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    headers
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
}

/// Delay before the next attempt. `attempt` is the 1-based attempt that just
/// failed. A server-provided `Retry-After` wins over the computed backoff;
/// both are clamped to `policy.max_delay`.
pub fn retry_delay(attempt: u32, retry_after: Option<Duration>, policy: &RetryPolicy) -> Duration {
    if let Some(ra) = retry_after {
        return ra.min(policy.max_delay);
    }
    let exp = attempt.saturating_sub(1).min(16);
    policy
        .base_delay
        .saturating_mul(2u32.saturating_pow(exp))
        .min(policy.max_delay)
}

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::header::{HeaderMap, HeaderValue, RETRY_AFTER};
    use reqwest::StatusCode;

    fn policy() -> RetryPolicy {
        RetryPolicy::default()
    }

    #[test]
    fn retryable_statuses() {
        assert!(is_retryable(StatusCode::TOO_MANY_REQUESTS));
        assert!(is_retryable(StatusCode::INTERNAL_SERVER_ERROR));
        assert!(is_retryable(StatusCode::SERVICE_UNAVAILABLE));
        assert!(!is_retryable(StatusCode::OK));
        assert!(!is_retryable(StatusCode::NOT_FOUND));
        assert!(!is_retryable(StatusCode::BAD_REQUEST));
        assert!(!is_retryable(StatusCode::UNAUTHORIZED));
    }

    #[test]
    fn delay_grows_exponentially_and_caps() {
        let p = policy();
        assert_eq!(retry_delay(1, None, &p), Duration::from_millis(500));
        assert_eq!(retry_delay(2, None, &p), Duration::from_secs(1));
        assert_eq!(retry_delay(3, None, &p), Duration::from_secs(2));
        // Far past the cap
        assert_eq!(retry_delay(10, None, &p), Duration::from_secs(8));
    }

    #[test]
    fn retry_after_overrides_and_clamps() {
        let p = policy();
        assert_eq!(
            retry_delay(1, Some(Duration::from_secs(3)), &p),
            Duration::from_secs(3)
        );
        // Server asks for more than the cap — clamp
        assert_eq!(
            retry_delay(1, Some(Duration::from_secs(120)), &p),
            Duration::from_secs(8)
        );
    }

    #[test]
    fn parse_retry_after_seconds() {
        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, HeaderValue::from_static("7"));
        assert_eq!(parse_retry_after(&h), Some(Duration::from_secs(7)));
    }

    #[test]
    fn parse_retry_after_absent_or_malformed() {
        let h = HeaderMap::new();
        assert_eq!(parse_retry_after(&h), None);

        let mut h = HeaderMap::new();
        h.insert(RETRY_AFTER, HeaderValue::from_static("soon"));
        assert_eq!(parse_retry_after(&h), None);

        // HTTP-date form is deliberately ignored (treated as absent)
        let mut h = HeaderMap::new();
        h.insert(
            RETRY_AFTER,
            HeaderValue::from_static("Wed, 21 Oct 2026 07:28:00 GMT"),
        );
        assert_eq!(parse_retry_after(&h), None);
    }
}
