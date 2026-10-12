import packageInfo from "../package.json" with { type: "json" };
import releaseConfig from "../release.json" with { type: "json" };
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Library from "./library.js";
import {
  families,
  SourceError,
  type IndexerPlugin,
  type PluginHost,
} from "./model.js";
import { Network } from "./network.js";

const run = async <A>(
  effect: Effect.Effect<A, SourceError, Network>,
  host: PluginHost,
  signal?: AbortSignal,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    effect.pipe(Effect.provideService(Network, { host })),
    { signal },
  );
  if (Exit.isSuccess(exit)) return exit.value;
  if (signal?.aborted)
    throw host.fail("timeout", "Search cancelled or timed out.");
  const error = Cause.squash(exit.cause);
  if (error instanceof SourceError) throw host.fail(error.kind, error.message);
  throw host.fail(
    "error",
    "Source configuration or response was invalid. Check the encrypted credential JSON and library settings.",
  );
};

export default {
  apiVersion: 1,
  version: packageInfo.version,
  type: releaseConfig.type,
  label: "BookOrbit ShadowLib",
  update: {
    manifestUrl: `https://github.com/${releaseConfig.repository}/releases/latest/download/${releaseConfig.type}.json`,
    ed25519PublicKey: releaseConfig.publicKey,
  },
  requiresCredential: false,
  credentialKind: "apiKey",
  mediaKinds: ["ebook", "audiobook"],
  supportsIsbnSearch: true,
  usesCategories: false,
  seedsBack: false,
  defaultBaseUrl: "https://open-slum.org",
  baseUrlHint:
    "Open Slum directory origin. Credentials are JSON in the encrypted API key field; never enter them as settings.",
  settingsFields: [
    {
      key: "browserHelperUrl",
      type: "string",
      label: "Browser helper URL",
      default: "",
      hint: "Optional TRAWL or FlareSolverr URL (base URL or /v1). For LAN helpers, enable Allow private IP addresses. Run Test connection to warm sessions; leave empty for HTTP only.",
    },
    {
      key: "libraries",
      type: "string",
      format: "list",
      options: families,
      minItems: 1,
      label: "Libraries to search",
      default: families.join(","),
      hint: "Search every selected catalogue, using working mirrors within each. Only libraries with API endpoints are included; some still need HTML search.",
    },
    {
      key: "ipfsOrigin",
      type: "string",
      label: "IPFS gateway",
      default: "https://dweb.link",
      hint: "HTTPS origin used for Liber3 files.",
    },
  ],
  search(q, cfg, host, signal) {
    return run(Library.search(q, cfg), host, signal);
  },
  async test(cfg, host) {
    try {
      return await run(Library.test(cfg), host);
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Connection test failed.",
      };
    }
  },
  resolveFile(release, cfg, host, signal) {
    return run(Library.resolveFile(release, cfg), host, signal);
  },
} satisfies IndexerPlugin;
