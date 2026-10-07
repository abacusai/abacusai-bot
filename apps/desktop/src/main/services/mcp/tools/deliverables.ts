import type { ChannelCapabilities } from "@abacus-ai/agent/channel";
import { DOCUMENT_EXTENSIONS } from "@abacus-ai/agent/send-media";

import type { ToolDefinition } from "./definition";

/**
 * Handing finished work over: serving a folder, presenting files. An app chat
 * opens them in a pane; a chat that takes media (the phone) gets them sent
 * into it, and a served page as a screenshot, since a phone cannot open it.
 */

const toChat = (channel: ChannelCapabilities): boolean =>
  channel.media || channel.documents;
export const DELIVERABLES_TOOLS: ToolDefinition[] = [
  {
    name: "serve",
    toolsets: "always",
    description: (channel) =>
      [
        "Serve a directory over http and get back a URL, so a web page you wrote can actually",
        "be opened. Static files only: html, css, js, images.",
        "",
        "Use it the moment you have written a page the user is meant to look at. `bash` cannot",
        "do this: it runs a command to completion, so a dev server started there is killed as",
        "soon as it reports being ready, and the URL answers nothing.",
        "",
        ...(toChat(channel)
          ? [
              "The URL opens on this computer only: the user cannot open it from their phone, and",
              "there is no live link to give them. Hand it to present_deliverable, which sends them",
              "a screenshot of the page. A long write-up reads better as a `page` link.",
            ]
          : [
              "Then hand the URL to present_deliverable: that is what opens the preview pane. A URL",
              "in prose is not previewed and not recorded.",
            ]),
        "",
        "Actions:",
        '  "start": serve a directory (directory). Serving it again returns the same URL.',
        '  "stop":  stop serving one (directory).',
        '  "list":  what is being served right now.',
      ].join("\n"),
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "stop", "list"],
          description: "What to do.",
        },
        directory: {
          type: "string",
          description:
            "The directory to serve. A relative path resolves against the workspace directory.",
        },
      },
      required: ["action"],
    },
    run: (host, args, callerSession) => host.serve(args, callerSession),
  },
  {
    name: "present_deliverable",
    toolsets: "always",
    description: (channel) =>
      toChat(channel)
        ? [
            "Send the finished work into this chat. Call this at the end of a turn that produced",
            "files, listing what the user asked for, most important first.",
            "",
            "Each item arrives in the chat with your answer: an image (png, jpg, webp) as a picture,",
            `any other file as a document under its file name (${DOCUMENT_EXTENSIONS.join(", ")}; at`,
            "most 16 MB). The first text of your answer goes with the first item as its caption, so",
            "keep that short. A served page's URL arrives as a screenshot of the page: the user",
            "cannot open a live preview from their phone. Naming a path in prose sends nothing.",
            "",
            "List the deliverables, not the workings: the report, not the six scratch files it",
            "was assembled from.",
            "",
            "Call it again whenever the user asks to see or get something you already made.",
            "Sending the same file twice is cheap and safe.",
          ].join("\n")
        : [
            "Hand the finished work over. Call this at the end of a turn that produced files,",
            "listing what the user asked for, most important first.",
            "",
            "The items become a files card in the chat and are filed as artifacts; in a session",
            "the first one also opens in the preview pane. Naming a path in prose does none of",
            "that, and a file written with `bash` is not recorded anywhere unless it is declared",
            "here. To hand a file to a person on a messaging channel, use send_chat_message with",
            "attachment_path as well.",
            "",
            "List the deliverables, not the workings: the report, not the six scratch files it",
            "was assembled from.",
            "",
            "Call it again whenever the user asks to see, show, open, or look at something you",
            "already made. The pane may have been closed or the app restarted since, and this is",
            "the only way to put the file back on screen. Describing it, or rendering its pages,",
            "into the chat, does not show it. Presenting the same file twice is cheap and safe.",
          ].join("\n"),
    inputSchema: (channel) => ({
      type: "object",
      properties: {
        items: {
          type: "array",
          description: toChat(channel)
            ? "The deliverables, most important first. The first one carries your answer's first text."
            : "The deliverables, most important first. The first one is opened in the preview pane.",
          items: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path to the file, or an http(s) URL (a served app). A relative path resolves against " +
                  "the workspace directory. Files must exist; this reports the ones that do not.",
              },
              label: {
                type: "string",
                description:
                  'Short human name, e.g. "Q3 deck (PDF)". Defaults to the file name.',
              },
            },
            required: ["path"],
          },
        },
        summary: {
          type: "string",
          description: "One line about what was produced.",
        },
      },
      required: ["items"],
    }),
    run: (host, args, callerSession) =>
      host.presentDeliverable(args, callerSession),
  },
];
