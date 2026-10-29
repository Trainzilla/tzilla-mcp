import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool, trainerId, pageShape } from "../kit.js";

const id = z.string().min(1);
const clientId = id.describe("Client's User _id (from list_clients)");
const isoDate = z.string().describe("ISO date, e.g. 2026-11-01");

const PLAN = `_id name category amount currency prices { currency amount } period interval description isActive
  listedOnPaymentPage ownedByOrganization organizationId meta { freeTrialSessions sessionsIncludedPerMonth sessionRollover noShowCountsAsUsed sessionsPer }
  directPayment { enabled url upiId provider instructions cardCheckout razorpayCheckout }`;
const INVOICE = `_id invoiceNumber sellerType clientUserId source issuedAt paidAt paymentMethod description periodStart periodEnd
  currency total isTaxInvoice emailedAt seller { name email phone address gstin } buyer { name email phone address gstin }
  tax { ratePercent taxable cgst sgst sacCode }`;
const PAYMENT = `_id subscriptionId invoiceId amount currency status method paymentProvider purchaseDate expiryDate description
  client { _id name email } plan { _id name }`;
const SUBSCRIPTION = `_id type status renewalStatus startedAt currentPeriodEnd paymentProvider client { _id name email } plan { _id name amount currency }
  pauses { _id startAt endAt reason extendsValidity }`;
const ORG_SUB = `_id organizationId tier billingMode seatCount status startedAt currentPeriodEnd currency cancelAtPeriodEnd pendingTier`;

export function registerBusinessTools(server: McpServer): void {
  /* ── Plans the coach sells ── */
  readTool(server, {
    name: "list_my_plans",
    desc: "The coaching plans the coach sells (price in every currency, billing period, session rules, whether active/listed, who collects payment).",
    field: "subscriptionPlansForTrainer",
    args: "trainerId: ID!, pagination: PaginationInput",
    select: PLAN,
    shape: { ...pageShape },
    resolve: async (i) => ({ trainerId: await trainerId(), pagination: { pageNumber: i.pageNumber, pageSize: i.pageSize } }),
  });
  writeTool(server, {
    name: "create_plan",
    desc: "Create a coaching plan clients can buy. amount is in minor units (paise/cents); period MONTHLY or YEARLY; interval = number of periods per billing cycle. Add per-currency prices afterwards with update_plan_prices.",
    field: "createPlan",
    args: "input: CreatePlanInput!",
    select: PLAN,
    shape: {
      input: z.object({
        name: z.string().min(1),
        amount: z.number().int().positive().describe("Minor units, e.g. 499900 = ₹4,999"),
        currency: z.string().length(3).optional(),
        period: z.enum(["MONTHLY", "YEARLY"]),
        interval: z.number().int().min(1).default(1),
        description: z.string().optional(),
        freeTrialSessions: z.number().int().min(0).optional(),
        sessionsIncludedPerMonth: z.number().int().min(0).optional(),
        sessionRollover: z.boolean().optional(),
        noShowCountsAsUsed: z.boolean().optional(),
        sessionsPer: z.enum(["MONTH", "PLAN_PERIOD"]).optional(),
        listedOnPaymentPage: z.boolean().optional(),
        ownedByGym: z.boolean().optional(),
      }),
    },
  });
  writeTool(server, {
    name: "update_plan_prices",
    desc: "Replace the per-currency price list of a plan (minor units). Existing subscribers keep their current price.",
    field: "updatePlanPrices",
    args: "input: UpdatePlanPricesInput!",
    select: PLAN,
    shape: {
      input: z.object({ planId: id, prices: z.array(z.object({ currency: z.string().length(3), amount: z.number().int().positive() })).min(1) }),
    },
  });
  writeTool(server, {
    name: "set_plan_active",
    desc: "Activate or deactivate a plan (deactivated plans can't be bought; current subscribers keep running).",
    field: "updatePlanActivity",
    args: "input: UpdatePlanActivityInput!",
    select: PLAN,
    shape: { input: z.object({ planId: id, isActive: z.boolean() }) },
  });
  writeTool(server, {
    name: "set_plan_listed",
    desc: "Show or hide a plan on the coach's public payment page.",
    field: "updatePlanListing",
    args: "input: UpdatePlanListingInput!",
    select: PLAN,
    shape: { input: z.object({ planId: id, listedOnPaymentPage: z.boolean() }) },
  });
  writeTool(server, {
    name: "update_plan_session_rules",
    desc: "Change how many 1:1 sessions a plan includes per month and whether they roll over / no-shows count as used.",
    field: "updatePlanSessionRules",
    args: "input: UpdatePlanSessionRulesInput!",
    select: PLAN,
    shape: {
      input: z.object({
        planId: id,
        sessionsIncludedPerMonth: z.number().int().min(0).optional(),
        sessionRollover: z.boolean().optional(),
        noShowCountsAsUsed: z.boolean().optional(),
        sessionsPer: z.enum(["MONTH", "PLAN_PERIOD"]).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "delete_plan",
    desc: "Delete a coaching plan (blocked while it has live subscribers — deactivate instead).",
    field: "deletePlan",
    args: "planId: ID!",
    shape: { planId: id },
    destructive: true,
  });
  readTool(server, {
    name: "list_plan_purchases",
    desc: "One-off purchases of the coach's marketplace workout/diet plans and templates (buyer, amount, status, whether the PDF was sent).",
    field: "planPurchasesForTrainer",
    select: "_id planId planType planTitle buyerName buyerEmail clientId amount currency status pdfSent createdAt",
  });
  writeTool(server, {
    name: "create_plan_share_link",
    desc: "Create a private no-login link to a workout or diet plan (branded PDF, Coach Pro) to send by WhatsApp. The URL is shown once.",
    field: "createPlanShareLink",
    args: "planType: PlanShareType!, planId: ID!, expiresInDays: Int",
    select: "url expiresAt",
    shape: { planType: z.enum(["WORKOUT", "DIET"]), planId: id, expiresInDays: z.number().int().min(1).max(90).optional() },
  });
  readTool(server, {
    name: "get_plan_share_info",
    desc: "How many private links are live for a plan and how often they were opened.",
    field: "planShareInfo",
    args: "planType: PlanShareType!, planId: ID!",
    select: "activeLinks totalViews lastViewedAt",
    shape: { planType: z.enum(["WORKOUT", "DIET"]), planId: id },
  });
  writeTool(server, {
    name: "revoke_plan_share_links",
    desc: "Turn off every live private link for a plan. Returns how many were live.",
    field: "revokePlanShareLinks",
    args: "planType: PlanShareType!, planId: ID!",
    shape: { planType: z.enum(["WORKOUT", "DIET"]), planId: id },
    destructive: true,
  });

  /* ── Subscriptions, pauses, desk payments ── */
  writeTool(server, {
    name: "cancel_client_subscription",
    desc: "Cancel a client's subscription (stops renewal; access runs to period end). Confirm the client and plan with the coach first.",
    field: "cancelSubscription",
    args: "subscriptionId: ID!",
    select: SUBSCRIPTION,
    shape: { subscriptionId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "pause_membership",
    desc: "Pause a client's membership between two dates (freezes the clock; validity extends if the plan allows).",
    field: "pauseMembership",
    args: "input: PauseMembershipInput!",
    select: SUBSCRIPTION,
    shape: { input: z.object({ subscriptionId: id, startAt: isoDate, endAt: isoDate, reason: z.string().optional() }) },
  });
  writeTool(server, {
    name: "end_membership_pause",
    desc: "End a membership pause early.",
    field: "endMembershipPause",
    args: "subscriptionId: ID!, pauseId: ID!",
    select: SUBSCRIPTION,
    shape: { subscriptionId: id, pauseId: id },
  });
  const deskInput = z.object({
    planId: id,
    startDate: isoDate,
    endDate: isoDate.optional().describe("Defaults to one plan period after startDate"),
    amount: z.number().int().positive().optional().describe("Minor units; defaults to the plan price"),
    method: z.enum(["CASH", "UPI", "CARD", "BANK_TRANSFER", "DIRECT_LINK", "OTHER"]),
    reference: z.string().optional(),
    paidAt: isoDate.optional(),
  });
  writeTool(server, {
    name: "record_coach_desk_payment",
    desc: "Solo coach: record a cash/UPI/bank payment from one of their own clients — creates an active membership (no auto-renew), the payment and an invoice.",
    field: "recordCoachDeskPayment",
    args: "clientId: ID!, input: RecordDeskMembershipInput!",
    select: SUBSCRIPTION,
    shape: { clientId, input: deskInput },
  });
  readTool(server, {
    name: "get_coach_client_desk_record",
    desc: "Desk (cash/UPI) payments a solo coach has recorded for one client, and whether new ones can be recorded.",
    field: "coachClientDeskRecord",
    args: "clientId: ID!",
    select: "canRecord",
    shape: { clientId },
  });
  writeTool(server, {
    name: "record_gym_desk_membership",
    desc: "Gym staff: record a membership paid at the desk for a gym member (needs desk-payment permission in the gym).",
    field: "recordDeskMembership",
    args: "organizationId: ID!, clientId: ID!, input: RecordDeskMembershipInput!",
    select: SUBSCRIPTION,
    shape: { organizationId: id, clientId, input: deskInput },
  });

  /* ── Payments, earnings, direct-pay claims ── */
  readTool(server, {
    name: "list_payments",
    desc: "Payments received by the coach (amount, status, method, client, plan), newest first. Amounts are in minor units.",
    field: "paymentsForTrainer",
    args: "trainerId: ID!, pagination: PaginationInput",
    select: PAYMENT,
    shape: { ...pageShape },
    resolve: async (i) => ({ trainerId: await trainerId(), pagination: { pageNumber: i.pageNumber, pageSize: i.pageSize } }),
  });
  readTool(server, {
    name: "list_client_payments",
    desc: "Payments one client made (to this coach), newest first.",
    field: "paymentsForClient",
    args: "clientId: ID!, pagination: PaginationInput",
    select: PAYMENT,
    shape: { clientId, pagination: z.object({ pageNumber: z.number().int().min(1), pageSize: z.number().int().min(1).max(100) }).optional() },
  });
  readTool(server, {
    name: "get_coach_dashboard_stats",
    desc: "Solo-coach dashboard numbers: active clients, revenue this vs last month (minor units), growth %, 12-month revenue series, sessions this week and retention %.",
    field: "trainerDashboardStats",
    select: "activeClients currency revenueThisMonthMinor revenuePrevMonthMinor revenueGrowthPct sessionsThisWeek retentionPct revenueSeries { monthISO amountMinor }",
  });
  readTool(server, {
    name: "list_direct_payment_claims",
    desc: "Clients' 'I've paid' claims for the coach's direct UPI/link payments. PENDING ones await confirm_direct_payment_claim or reject_direct_payment_claim.",
    field: "myDirectPaymentClaims",
    args: "status: DirectPaymentClaimStatus",
    select: "_id kind planId programType planName amount currency buyerName buyerEmail reference note status subscriptionId rejectReason createdAt decidedAt",
    shape: { status: z.enum(["PENDING", "PROCESSING", "CONFIRMED", "REJECTED"]).optional() },
  });
  writeTool(server, {
    name: "confirm_direct_payment_claim",
    desc: "Confirm a client's direct payment arrived: activates their plan (creating the account if needed) and records the payment. Only after the coach has seen the money.",
    field: "confirmDirectPaymentClaim",
    args: "id: ID!",
    select: "_id status subscriptionId decidedAt",
    shape: { id },
  });
  writeTool(server, {
    name: "reject_direct_payment_claim",
    desc: "Reject a direct-payment claim (money not received), with an optional reason shown to the client.",
    field: "rejectDirectPaymentClaim",
    args: "id: ID!, reason: String",
    select: "_id status rejectReason",
    shape: { id, reason: z.string().max(500).optional() },
  });
  writeTool(server, {
    name: "update_my_direct_payment",
    desc: "Set how clients pay the coach directly: UPI ID and/or a payment link, plus instructions. Turning it on routes new checkouts to the coach.",
    field: "updateMyDirectPayment",
    args: "input: DirectPaymentInput!",
    select: "userId directPayment { enabled url upiId provider instructions cardCheckout razorpayCheckout }",
    shape: {
      input: z.object({ enabled: z.boolean(), url: z.string().optional(), upiId: z.string().optional(), instructions: z.string().max(500).optional() }),
    },
  });
  readTool(server, {
    name: "get_payment_connections",
    desc: "Whether the coach has connected their own Stripe and/or Razorpay account for card/UPI checkout (never returns keys). Connecting needs secret keys, so do it in the web app.",
    field: "connections",
    doc: "query Tool { myStripeConnection { connected keyLast4 livemode accountCountry connectedAt } myRazorpayConnection { connected keyLast4 livemode connectedAt } }",
  });

  /* ── Invoices ── */
  readTool(server, {
    name: "list_seller_invoices",
    desc: "Invoices the coach (or a gym, with organizationId) issued, newest first. Totals are minor units.",
    field: "sellerInvoices",
    args: "organizationId: ID, limit: Int, offset: Int",
    select: INVOICE,
    shape: { organizationId: id.optional(), limit: z.number().int().min(1).max(200).default(50), offset: z.number().int().min(0).default(0) },
  });
  readTool(server, {
    name: "list_client_invoices",
    desc: "Invoices issued to one client.",
    field: "clientInvoices",
    args: "clientId: ID!",
    select: INVOICE,
    shape: { clientId },
  });
  readTool(server, {
    name: "get_invoice_pdf_url",
    desc: "Short-lived download link for an invoice PDF.",
    field: "invoicePdfUrl",
    args: "invoiceId: ID!",
    shape: { invoiceId: id },
  });
  writeTool(server, {
    name: "resend_invoice_email",
    desc: "Email an invoice to the client again.",
    field: "resendInvoiceEmail",
    args: "invoiceId: ID!",
    shape: { invoiceId: id },
  });
  readTool(server, {
    name: "get_invoice_settings",
    desc: "Invoice settings (legal name, address, GSTIN, tax rate, prefix, footer, branding status) for the coach or a gym.",
    field: "invoiceSettings",
    args: "organizationId: ID",
    select: "sellerType legalName address gstin taxRatePercent invoicePrefix footerNote invoicedByGym defaultName sampleNumber brandingStatus",
    shape: { organizationId: id.optional() },
  });
  writeTool(server, {
    name: "update_invoice_settings",
    desc: "Save invoice settings. Setting a GSTIN turns new invoices into GST tax invoices (legalName + address required).",
    field: "updateInvoiceSettings",
    args: "organizationId: ID, input: InvoiceSettingsInput!",
    select: "sellerType legalName address gstin taxRatePercent invoicePrefix footerNote sampleNumber",
    shape: {
      organizationId: id.optional(),
      input: z.object({
        legalName: z.string().optional(),
        address: z.string().optional(),
        gstin: z.string().length(15).optional(),
        taxRatePercent: z.number().int().optional().describe("0, 5, 12, 18 or 28"),
        invoicePrefix: z.string().max(5).optional(),
        footerNote: z.string().optional(),
      }),
    },
  });

  /* ── Coach Pro, referrals ── */
  readTool(server, {
    name: "get_coach_pro_pricing",
    desc: "Coach Pro plans and prices in the coach's currency, and whether the subscription auto-renews.",
    field: "coachProPricing",
    select: "currency autoRenewing fixedTermEndsAt recurringAvailable plans { id name description amount currency priceFormatted period interval }",
  });
  readTool(server, {
    name: "get_active_trainer_subscription",
    desc: "The coach's own Trainzilla (Coach Pro) subscription, if any.",
    field: "activeTrainerSubscription",
    select: SUBSCRIPTION,
  });
  writeTool(server, {
    name: "create_pro_checkout_link",
    desc: "Create a checkout link for the coach to buy Coach Pro (optionally a specific planId). Opening and paying is the coach's step.",
    field: "createProCheckoutLink",
    args: "planId: ID",
    select: "url expiresAt",
    shape: { planId: id.optional() },
  });
  readTool(server, {
    name: "get_my_referral_program",
    desc: "The coach's referral code and results: sign-ups, paid referrals, rewards applied/pending.",
    field: "myReferralProgram",
    select: "code active rewardMonthsPerPaidReferral referredProMonths signedUp paid rewardsApplied rewardsPending",
  });

  /* ── Gym billing ── */
  writeTool(server, {
    name: "cancel_organization_subscription",
    desc: "Cancel a gym's Trainzilla seat subscription at period end (owner only).",
    field: "cancelOrganizationSubscription",
    args: "organizationId: ID!",
    select: ORG_SUB,
    shape: { organizationId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "resume_organization_subscription",
    desc: "Undo a scheduled cancellation of a gym's seat subscription.",
    field: "resumeOrganizationSubscription",
    args: "organizationId: ID!",
    select: ORG_SUB,
    shape: { organizationId: id },
  });
  writeTool(server, {
    name: "change_organization_subscription_tier",
    desc: "Move a gym's seat subscription to a different tier (see list_organization_seat_tiers).",
    field: "changeOrganizationSubscriptionTier",
    args: "organizationId: ID!, tier: OrganizationSeatTier!",
    select: ORG_SUB,
    shape: { organizationId: id, tier: z.string().min(1) },
  });
  writeTool(server, {
    name: "refresh_organization_subscription",
    desc: "Re-sync a gym's seat subscription state from the payment provider.",
    field: "refreshOrganizationSubscription",
    args: "organizationId: ID!",
    select: ORG_SUB,
    shape: { organizationId: id },
  });
}
