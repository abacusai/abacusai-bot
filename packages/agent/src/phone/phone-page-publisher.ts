/**
 * The phone loop's pages on the account's channels endpoint (`publish_page`),
 * with the Abacus key the agent already runs on, read at publish time.
 */
import { abacusV1BaseUrl } from "../abacus-endpoint.js";
import type { PagePublisher } from "./phone-page-tool.js";

const PUBLISH_TIMEOUT_MS = 30_000;

export function channelsPagePublisher(
  baseUrl: () => string = () => abacusV1BaseUrl()
): PagePublisher {
  return {
    async publish(page, pageId) {
      const key = (process.env.ABACUS_API_KEY ?? "").trim();

      if (key.length === 0) throw new Error("Abacus.AI is not connected.");

      const response = await fetch(`${baseUrl()}/abacusaibot_channels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "publish_page",
          page,
          ...(pageId != null ? { page_id: pageId } : {}),
        }),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      });
      const body = (await response.json().catch(() => ({}))) as {
        page_id?: unknown;
        url?: unknown;
      };

      if (!response.ok)
        throw new Error(`publish_page returned ${response.status}`);
      if (typeof body.page_id !== "string" || typeof body.url !== "string")
        throw new Error("publish_page returned no page");

      return { page_id: body.page_id, url: body.url };
    },
  };
}
