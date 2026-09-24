import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * `outputFileTracingRoot` is set explicitly, and that is not cosmetic.
 *
 * This prototype lives inside a larger repository that has its own lockfile, so
 * Next would otherwise infer *that* directory as the workspace root and build a
 * file trace over the parent's entire `node_modules`. On this machine that
 * turned "Collecting page data" into a multi-minute hang. Bounding the trace to
 * this directory keeps the build self-contained.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: here,
};

export default nextConfig;
