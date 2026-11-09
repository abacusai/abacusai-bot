import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import {
  MAX_CHANNEL_MEMBERS,
  MIN_CHANNEL_MEMBERS,
  type ChannelSummary,
  type ChannelThread,
  type ChannelsEvent,
} from "../channels";
import { mutation, query, subscription } from "./base";
import { BotId, NoInput } from "./ids";

const ChannelId = v.pipe(
  v.string(),
  v.nonEmpty("channelId is required"),
  v.regex(/^[A-Za-z0-9_-]+$/, "channelId has characters an id cannot have")
);
const Members = v.pipe(
  v.array(BotId),
  v.minLength(
    MIN_CHANNEL_MEMBERS,
    `A channel needs at least ${MIN_CHANNEL_MEMBERS} bots.`
  ),
  v.maxLength(
    MAX_CHANNEL_MEMBERS,
    `A channel can have at most ${MAX_CHANNEL_MEMBERS} bots.`
  )
);
const Text = v.pipe(
  v.string(),
  v.trim(),
  v.nonEmpty("Write something first."),
  v.maxLength(20_000)
);

/** Channels: the user and several of their bots in one thread. */
export const channels = {
  list: query.input(NoInput).output(type<ChannelSummary[]>()),
  thread: query
    .input(v.object({ channelId: ChannelId }))
    .output(type<ChannelThread>()),
  /** `text`, when given, is the first message: the channel starts with it. */
  create: mutation
    .input(
      v.object({
        botIds: Members,
        name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
        about: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
        text: v.optional(Text),
      })
    )
    .output(type<ChannelSummary>()),
  update: mutation
    .input(
      v.object({
        channelId: ChannelId,
        name: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(80))),
        about: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
        botIds: v.optional(Members),
      })
    )
    .output(type<ChannelSummary>()),
  remove: mutation
    .input(v.object({ channelId: ChannelId }))
    .output(type<void>()),
  post: mutation
    .input(
      v.object({
        channelId: ChannelId,
        text: Text,
        /** The bot message this one replies to: that bot answers. */
        replyTo: v.optional(v.string()),
      })
    )
    .output(type<void>()),
  /** Pin a line (or a message's text) as a decision every bot sees. */
  pin: mutation
    .input(
      v.object({
        channelId: ChannelId,
        text: v.optional(Text),
        messageId: v.optional(v.string()),
      })
    )
    .output(type<void>()),
  unpin: mutation
    .input(v.object({ channelId: ChannelId, decisionId: v.string() }))
    .output(type<void>()),
  /** Start a discussion's agreed items as work, each in its owner's own chat. */
  startAgreed: mutation
    .input(v.object({ channelId: ChannelId, messageId: v.string() }))
    .output(type<void>()),
  /** Create the bot a message proposed (and add it here), or dismiss it. */
  decideProposal: mutation
    .input(
      v.object({
        channelId: ChannelId,
        messageId: v.string(),
        create: v.boolean(),
      })
    )
    .output(type<void>()),
  /** Stop every bot answering in the channel and drop what is queued. */
  stopAll: mutation
    .input(v.object({ channelId: ChannelId }))
    .output(type<void>()),
  events: subscription
    .input(NoInput)
    .output(eventIterator(type<ChannelsEvent>())),
};
