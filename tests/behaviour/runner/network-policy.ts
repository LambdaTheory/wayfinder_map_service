// Shared by reviewer and scenario/interactive sandboxes. Apply IPv4-only grants after these denies.
// Seatbelt's localhost matcher misses ::ffff:0.0.0.0, which reaches an IPv4 loopback listener.
export const localNetworkDenials = [
  '(deny network-outbound (remote ip "localhost:*"))',
  '(deny network-outbound (remote tcp6 "*:*"))',
] as const;
