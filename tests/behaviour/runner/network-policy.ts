// Shared by reviewer and scenario/interactive sandboxes. Apply IPv4-only grants after these denies.
// Seatbelt's localhost matcher misses ::ffff:0.0.0.0, which reaches an IPv4 loopback listener.
export const localNetworkDenials = [
  '(deny network-outbound (remote ip "localhost:*"))',
  '(deny network-outbound (remote tcp6 "*:*"))',
  '(deny network-outbound (remote udp4 "*:*"))',
  '(deny network-outbound (remote udp6 "*:*"))',
] as const;
