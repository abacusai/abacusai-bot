import { impl } from "./impl";

export const referralsRouter = impl.referrals.router({
  summary: impl.referrals.summary.handler(({ context }) =>
    context.deps.host.fetchReferralSummary()
  ),
  gmailContacts: impl.referrals.gmailContacts.handler(({ context }) =>
    context.deps.host.listReferralGmailContacts()
  ),
  sendEmail: impl.referrals.sendEmail.handler(({ input, context }) =>
    context.deps.host.sendReferralEmailInvites(input.emails, input.message)
  ),
  whatsappContacts: impl.referrals.whatsappContacts.handler(({ context }) =>
    context.deps.host.listReferralWhatsappContacts()
  ),
  sendWhatsapp: impl.referrals.sendWhatsapp.handler(({ input, context }) =>
    context.deps.host.sendReferralWhatsappInvites(input.chatIds, input.message)
  ),
});
