/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Security headers that are static (host-independent) live here. The
  // per-request, nonce-based Content-Security-Policy is set in middleware.ts
  // because it needs a fresh nonce on every request.
  poweredByHeader: false,
};

export default nextConfig;
