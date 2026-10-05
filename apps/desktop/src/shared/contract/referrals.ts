import { type } from "@orpc/contract";
import * as v from "valibot";

import type {
  ReferralGmailContact,
  ReferralInviteOutcome,
  ReferralSummary,
  ReferralWhatsappContact,
} from "../contracts";
import { mutation, query } from "./base";
import { NoInput } from "./ids";

export const referrals = {
  /** Null when signed out or the platform did not answer. */
  summary: query.input(NoInput).output(type<ReferralSummary | null>()),
  gmailContacts: query.input(NoInput).output(type<ReferralGmailContact[]>()),
  sendEmail: mutation
    .input(
      v.object({
        // Checked and de-duplicated by the referral service, as for IPC.
        emails: v.array(v.string()),
        message: v.string(),
      })
    )
    .output(type<ReferralInviteOutcome>()),
  whatsappContacts: query
    .input(NoInput)
    .output(type<ReferralWhatsappContact[]>()),
  sendWhatsapp: mutation
    .input(v.object({ chatIds: v.array(v.string()), message: v.string() }))
    .output(type<ReferralInviteOutcome>()),
};
