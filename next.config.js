/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: {
      // /admin uploads (.docx up to 15 MB, images up to 8 MB) go through
      // Server Actions, which cap the request body at 1 MB by default.
      bodySizeLimit: "16mb",
    },
  },
};

module.exports = nextConfig;
