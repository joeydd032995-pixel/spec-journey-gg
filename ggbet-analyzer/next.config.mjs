/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow recharts + papaparse to be bundled client-side
  transpilePackages: [],
  // Vercel edge functions aren't needed; stick to Node.js runtime for the BetsAPI route
  // (needs persistent HTTP connections + longer timeouts)
  serverExternalPackages: [],
};

export default nextConfig;
