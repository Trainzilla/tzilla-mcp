import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readTool, writeTool } from "../kit.js";

const id = z.string().min(1);
const orgId = id.describe("Gym id (from list_my_organizations)");
const isoDate = z.string().describe("ISO date/time");
const scopeType = z.enum(["ORGANIZATION", "COACH"]).describe("ORGANIZATION = a gym's community, COACH = the coach's own");

const POST = `_id scopeType scopeId kind text mediaUrls pinned reactionCount commentCount myReaction canDelete createdAt
  author { name } workout { title durationMinutes }`;
const INVITATION = `_id email invitedName invitedPhone channel type role status expiresAt inviteLink organizationId locationId`;
const KIOSK = `_id organizationId name locationId isPaired lastSeenAt isActive doorUnlockUrl doorUnlockMode`;
const IMPORT = `_id organizationId kind sourceName sourceType totalRows created skipped failed createdVia createdAt errors { row message }`;

export function registerCommunityGymTools(server: McpServer): void {
  /* ── Community ── */
  readTool(server, {
    name: "list_my_communities",
    desc: "Communities the coach can post in (their own and their gyms'), with unread counts and the latest post.",
    field: "myCommunities",
    select: "scopeType scopeId name canModerate unreadCount",
  });
  readTool(server, {
    name: "get_community_feed",
    desc: "Posts in a community, newest first (page back with `before`).",
    field: "communityFeed",
    args: "scopeType: CommunityScopeType!, scopeId: ID!, before: Date, limit: Int",
    select: POST,
    shape: { scopeType, scopeId: id, before: isoDate.optional(), limit: z.number().int().min(1).max(50).default(20) },
  });
  readTool(server, {
    name: "get_community_comments",
    desc: "Comments on a community post.",
    field: "communityComments",
    args: "postId: ID!",
    select: "_id postId text canDelete createdAt author { name }",
    shape: { postId: id },
  });
  writeTool(server, {
    name: "create_community_post",
    desc: "Publish a text post to a community — visible to every member immediately, so only after the coach approves the wording. (Photos/videos are added in the app.)",
    field: "createCommunityPost",
    args: "input: CreateCommunityPostInput!",
    select: POST,
    shape: { input: z.object({ scopeType, scopeId: id, text: z.string().min(1).max(2000) }) },
  });
  writeTool(server, {
    name: "add_community_comment",
    desc: "Comment on a community post as the coach.",
    field: "addCommunityComment",
    args: "postId: ID!, text: String!",
    select: "_id text createdAt",
    shape: { postId: id, text: z.string().min(1).max(1000) },
  });
  writeTool(server, {
    name: "react_to_community_post",
    desc: "React to a post (LIKE, FIRE or CLAP); repeating the same reaction removes it.",
    field: "reactToCommunityPost",
    args: "postId: ID!, type: CommunityReactionType!",
    select: "_id reactionCount myReaction",
    shape: { postId: id, type: z.enum(["LIKE", "FIRE", "CLAP"]) },
  });
  writeTool(server, {
    name: "pin_community_post",
    desc: "Pin or unpin a post at the top of the community (moderators).",
    field: "pinCommunityPost",
    args: "postId: ID!, pinned: Boolean!",
    select: "_id pinned",
    shape: { postId: id, pinned: z.boolean() },
  });
  writeTool(server, {
    name: "delete_community_post",
    desc: "Delete a community post (own post, or any if moderating).",
    field: "deleteCommunityPost",
    args: "postId: ID!",
    shape: { postId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "delete_community_comment",
    desc: "Delete a community comment.",
    field: "deleteCommunityComment",
    args: "commentId: ID!",
    shape: { commentId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "mark_community_seen",
    desc: "Mark a community as read (clears its unread count).",
    field: "markCommunitySeen",
    args: "scopeType: CommunityScopeType!, scopeId: ID!",
    shape: { scopeType, scopeId: id },
  });

  /* ── Gym check-in, kiosks, face recognition ── */
  readTool(server, {
    name: "list_gym_checkins",
    desc: "Door/desk check-ins at a gym in a date range (member, time, method), optionally for one member.",
    field: "gymCheckIns",
    args: "organizationId: ID!, from: Date, to: Date, limit: Int, userId: ID",
    select: "_id userId memberName at method kioskId confidence attendedSessionIds",
    shape: { organizationId: orgId, from: isoDate.optional(), to: isoDate.optional(), limit: z.number().int().min(1).max(500).default(100), userId: id.optional() },
  });
  writeTool(server, {
    name: "check_in_gym_member",
    desc: "Check a member in at the front desk. Returns whether it was a duplicate, the classes they were marked into and their membership status.",
    field: "checkInGymMember",
    args: "organizationId: ID!, userId: ID!",
    select: "memberName classes duplicate checkIn { _id at method }",
    shape: { organizationId: orgId, userId: id },
  });
  readTool(server, {
    name: "list_gym_kiosks",
    desc: "Check-in kiosks paired to a gym (online state, door-unlock config).",
    field: "gymKiosks",
    args: "organizationId: ID!",
    select: KIOSK,
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "create_gym_kiosk",
    desc: "Create a kiosk and get its one-time pairing code to enter on the kiosk screen.",
    field: "createGymKiosk",
    args: "organizationId: ID!, name: String!, locationId: ID",
    select: `pairingCode expiresAt kiosk { ${KIOSK} }`,
    shape: { organizationId: orgId, name: z.string().min(1), locationId: id.optional() },
  });
  writeTool(server, {
    name: "revoke_gym_kiosk",
    desc: "Disconnect and deactivate a kiosk.",
    field: "revokeGymKiosk",
    args: "organizationId: ID!, kioskId: ID!",
    shape: { organizationId: orgId, kioskId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "set_gym_kiosk_door",
    desc: "Configure a kiosk's door-unlock webhook and who it opens for (ACTIVE_ONLY members or ANY_MEMBER).",
    field: "setGymKioskDoor",
    args: "organizationId: ID!, kioskId: ID!, unlockUrl: String, mode: DoorUnlockMode",
    select: KIOSK,
    shape: { organizationId: orgId, kioskId: id, unlockUrl: z.string().url().optional(), mode: z.enum(["ACTIVE_ONLY", "ANY_MEMBER"]).optional() },
  });
  readTool(server, {
    name: "get_gym_face_enrolments",
    desc: "Whether face check-in is on for a gym and which members have enrolled.",
    field: "gymFaceEnrolments",
    args: "organizationId: ID!",
    select: "enabled attestedAt members { userId name consentedAt }",
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "set_gym_face_checkin",
    desc: "Turn face check-in on/off for a gym. Turning on requires attest: true (the gym confirms it has members' consent).",
    field: "updateGymFaceCheckin",
    args: "organizationId: ID!, enabled: Boolean!, attest: Boolean!",
    select: "enabled attestedAt",
    shape: { organizationId: orgId, enabled: z.boolean(), attest: z.boolean() },
  });
  writeTool(server, {
    name: "delete_gym_face_template",
    desc: "Delete one member's stored face template (e.g. on request).",
    field: "deleteGymFaceTemplate",
    args: "organizationId: ID!, userId: ID!",
    shape: { organizationId: orgId, userId: id },
    destructive: true,
  });

  /* ── Classes: standing bookings + roster edits ── */
  readTool(server, {
    name: "list_gym_class_standings",
    desc: "Members with a standing (every-week) booking on a class.",
    field: "gymClassStandings",
    args: "classId: ID!",
    select: "_id classId userId memberName weekdays allDays status classTitle startTime upcomingBooked upcomingWaitlisted nextStartAt",
    shape: { classId: id },
  });
  readTool(server, {
    name: "search_gym_class_members",
    desc: "Find gym members eligible to add to a class (by name/email).",
    field: "gymClassMemberSearch",
    args: "classId: ID!, search: String",
    select: "userId name email",
    shape: { classId: id, search: z.string().optional() },
  });
  writeTool(server, {
    name: "create_gym_class_standing",
    desc: "Book a member into a class every week (optionally only on given weekdays 0=Sun..6=Sat); books the upcoming sessions.",
    field: "createGymClassStanding",
    args: "classId: ID!, userId: ID, weekdays: [Int!]",
    select: "booked waitlisted skippedMembership standing { _id status weekdays }",
    shape: { classId: id, userId: id.optional(), weekdays: z.array(z.number().int().min(0).max(6)).optional() },
  });
  writeTool(server, {
    name: "cancel_gym_class_standing",
    desc: "End a member's standing class booking.",
    field: "cancelGymClassStanding",
    args: "standingId: ID!",
    shape: { standingId: id },
    destructive: true,
  });
  writeTool(server, {
    name: "add_member_to_gym_class_session",
    desc: "Add a member to one class session (waitlists if full).",
    field: "addMemberToGymClassSession",
    args: "sessionId: ID!, userId: ID!",
    select: "sessionId status",
    shape: { sessionId: id, userId: id },
  });
  writeTool(server, {
    name: "remove_member_from_gym_class_session",
    desc: "Remove a member from one class session.",
    field: "removeMemberFromGymClassSession",
    args: "sessionId: ID!, userId: ID!",
    select: "sessionId status",
    shape: { sessionId: id, userId: id },
  });

  /* ── Gym staff, people, announcements ── */
  writeTool(server, {
    name: "invite_gym_staff",
    desc: "Invite a staff member (admin/primary coach/coach) to a gym by email, optionally to a location.",
    field: "inviteOrganizationStaff",
    args: "input: InviteOrganizationStaffInput!",
    select: INVITATION,
    shape: {
      input: z.object({
        organizationId: orgId,
        email: z.string().email(),
        organizationRole: z.enum(["OWNER", "ADMIN", "PRIMARY_COACH", "COACH"]).optional(),
        locationId: id.optional(),
        locationRole: z.enum(["ADMIN", "PRIMARY_COACH", "COACH"]).optional(),
        expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "bulk_import_gym_coaches",
    desc: "Invite/assign many coaches to a gym in one go (rows of name + email, optional phone/location/roles).",
    field: "bulkImportOrganizationCoaches",
    args: "organizationId: ID!, defaultLocationId: ID, rows: [BulkImportOrganizationCoachRowInput!]!",
    select: "_id processedCount invitedCount assignedCount skippedCount failedCount rows { name email status message }",
    shape: {
      organizationId: orgId,
      defaultLocationId: id.optional(),
      rows: z
        .array(
          z.object({
            name: z.string().min(1),
            email: z.string().email(),
            phone: z.string().optional(),
            locationId: id.optional(),
            organizationRole: z.enum(["OWNER", "ADMIN", "PRIMARY_COACH", "COACH"]).optional(),
            locationRole: z.enum(["ADMIN", "PRIMARY_COACH", "COACH"]).optional(),
            notes: z.string().optional(),
          })
        )
        .min(1)
        .max(200),
    },
  });
  readTool(server, {
    name: "list_gym_coach_import_batches",
    desc: "Past bulk coach imports for a gym and their per-row outcomes.",
    field: "organizationCoachImportBatches",
    args: "organizationId: ID!, locationId: ID",
    select: "_id processedCount invitedCount assignedCount skippedCount failedCount source createdAt",
    shape: { organizationId: orgId, locationId: id.optional() },
  });
  writeTool(server, {
    name: "move_coach_under_gym",
    desc: "Move a solo coach's clients under a gym (the coach joins the gym; their plans pause during the move). Owner/admin action — high impact, confirm exactly which coach and gym.",
    field: "moveCoachUnderGym",
    args: "organizationId: ID!, coachId: ID",
    select: "clientsMoved plansPaused",
    shape: { organizationId: orgId, coachId: id.optional() },
  });
  writeTool(server, {
    name: "delete_gym_announcement",
    desc: "Delete a gym announcement.",
    field: "deleteGymAnnouncement",
    args: "organizationId: ID!, announcementId: ID!",
    shape: { organizationId: orgId, announcementId: id },
    destructive: true,
  });
  readTool(server, {
    name: "get_gym_member_record",
    desc: "A gym member's desk payments, receipt links and photo, and whether the viewer may record memberships.",
    field: "organizationMemberRecord",
    args: "organizationId: ID!, clientId: ID!",
    select: "photoUrl canRecord offlinePayments { _id planName amount currency method reference proofUrl paidAt }",
    shape: { organizationId: orgId, clientId: id },
  });
  readTool(server, {
    name: "list_gym_delegable_capabilities",
    desc: "Capability keys that can be given to custom gym roles (use with create/update_organization_custom_role).",
    field: "organizationDelegableCapabilities",
    select: "key label",
  });
  writeTool(server, {
    name: "update_gym_payout_settings",
    desc: "Set how a gym receives money: payoutMode plus bank details. Sensitive — confirm every digit with the owner.",
    field: "updateOrganizationPayoutSettings",
    args: "organizationId: ID!, payoutMode: String!, bank: OrganizationPayoutBankInput",
    select: "_id name",
    shape: {
      organizationId: orgId,
      payoutMode: z.string().min(1),
      bank: z.object({ accountHolderName: z.string().min(1), accountNumber: z.string().min(1), ifscCode: z.string().min(1), bankName: z.string().optional() }).optional(),
    },
  });
  writeTool(server, {
    name: "request_gym_enterprise",
    desc: "Ask the Trainzilla team for an enterprise plan for a gym (seats, phone, message).",
    field: "requestOrganizationEnterprise",
    args: "organizationId: ID!, input: RequestOrganizationEnterpriseInput!",
    shape: { organizationId: orgId, input: z.object({ seats: z.number().int().positive().optional(), phone: z.string().optional(), message: z.string().max(1000).optional() }) },
  });

  /* ── Gym custom domain ── */
  const DOMAIN = "hostname status sslStatus failureReason cnameTarget ownershipTxtName ownershipTxtValue";
  readTool(server, {
    name: "get_gym_custom_domain",
    desc: "The domain connected to a gym's public page and the DNS records still needed.",
    field: "organizationCustomDomain",
    args: "organizationId: ID!",
    select: DOMAIN,
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "connect_gym_custom_domain",
    desc: "Connect a custom domain to a gym's public page; returns the DNS records to add.",
    field: "connectOrganizationCustomDomain",
    args: "organizationId: ID!, hostname: String!",
    select: DOMAIN,
    shape: { organizationId: orgId, hostname: z.string().min(3) },
  });
  writeTool(server, {
    name: "refresh_gym_custom_domain",
    desc: "Re-check DNS/SSL status of a gym's custom domain.",
    field: "refreshOrganizationCustomDomain",
    args: "organizationId: ID!",
    select: DOMAIN,
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "remove_gym_custom_domain",
    desc: "Disconnect a gym's custom domain.",
    field: "removeOrganizationCustomDomain",
    args: "organizationId: ID!",
    shape: { organizationId: orgId },
    destructive: true,
  });

  /* ── Legacy data import (leads / members / sales from Sheets) ── */
  readTool(server, {
    name: "list_gym_imports",
    desc: "Past data imports for a gym (leads, members, sales) with created/skipped/failed counts.",
    field: "organizationImports",
    args: "organizationId: ID!",
    select: IMPORT,
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "start_gym_import_from_sheet",
    desc: "Read a shared Google Sheet URL into an import draft (kind LEADS, MEMBERS or SALES). Returns headers, sample rows and a suggested column mapping — review it with the coach, then call commit_gym_import. (CSV/xlsx uploads are done in the web app.)",
    field: "createOrganizationImportDraftFromSheet",
    args: "organizationId: ID!, kind: OrganizationImportKind!, url: String!",
    select: "draftId kind sourceName totalRows headers sampleRows fields { key label required } suggestedMapping { field column }",
    shape: { organizationId: orgId, kind: z.enum(["LEADS", "MEMBERS", "SALES"]), url: z.string().url() },
  });
  writeTool(server, {
    name: "commit_gym_import",
    desc: "Apply an import draft with the agreed column mapping (field → zero-based column index). Creates the records.",
    field: "commitOrganizationImport",
    args: "draftId: ID!, mapping: [OrganizationImportMappingInput!]!",
    select: IMPORT,
    shape: { draftId: id, mapping: z.array(z.object({ field: z.string().min(1), column: z.number().int().min(0) })).min(1) },
  });
  writeTool(server, {
    name: "undo_gym_import",
    desc: "Remove everything a given import created.",
    field: "undoOrganizationImport",
    args: "importId: ID!",
    shape: { importId: id },
    destructive: true,
  });
  readTool(server, {
    name: "list_gym_imported_members",
    desc: "Members imported from a gym's old system (ACTIVE/PAST), with search and paging.",
    field: "organizationImportedMembers",
    args: "organizationId: ID!, status: OrganizationImportedMemberStatus, search: String, pageNumber: Int, pageSize: Int",
    select: "total items { _id name email phone status planName joinedAt endedAt notes invitedAt }",
    shape: { organizationId: orgId, status: z.enum(["ACTIVE", "PAST"]).optional(), search: z.string().optional(), pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
  });
  readTool(server, {
    name: "list_gym_imported_sales",
    desc: "Historical sales imported for a gym.",
    field: "organizationImportedSales",
    args: "organizationId: ID!, pageNumber: Int, pageSize: Int",
    select: "_id soldAt amount currency memberName planName paymentMethod reference",
    shape: { organizationId: orgId, pageNumber: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(50) },
  });
  readTool(server, {
    name: "get_gym_imported_sales_summary",
    desc: "Totals of imported sales per currency and per month.",
    field: "organizationImportedSalesSummary",
    args: "organizationId: ID!",
    select: "firstMonth lastMonth totals { currency amount count }",
    shape: { organizationId: orgId },
  });
  writeTool(server, {
    name: "invite_imported_gym_member",
    desc: "Invite an imported member to join the gym on Trainzilla (sends them an invitation).",
    field: "inviteOrganizationImportedMember",
    args: "memberId: ID!, coachId: ID",
    select: "_id name invitedAt",
    shape: { memberId: id, coachId: id.optional() },
  });

  /* ── Invitations ── */
  writeTool(server, {
    name: "create_invite_link",
    desc: "Create a shareable client invite link (for WhatsApp) with an optional name/phone.",
    field: "createInviteLink",
    args: "input: CreateInviteLinkInput!",
    select: INVITATION,
    shape: { input: z.object({ name: z.string().optional(), phone: z.string().optional(), expiresInHours: z.number().int().min(1).max(24 * 90).optional() }) },
  });
  writeTool(server, {
    name: "send_bulk_invitations",
    desc: "Invite many clients by email in one call (Coach Pro). Returns per-row sent/skipped/failed.",
    field: "sendBulkInvitations",
    args: "input: SendBulkInvitationsInput!",
    select: "totalSubmitted sentCount skippedCount failedCount results { email name outcome message }",
    shape: {
      input: z.object({
        recipients: z.array(z.object({ email: z.string().email(), name: z.string().optional(), phone: z.string().optional() })).min(1).max(500),
        expiresInHours: z.number().int().min(1).optional(),
      }),
    },
  });
  writeTool(server, {
    name: "respond_to_invitation",
    desc: "Accept or decline an invitation addressed to the coach (e.g. a gym inviting them as a coach; see get_my_pending_org_invitations).",
    field: "respondToInvitation",
    args: "invitationId: ID!, accept: Boolean!",
    select: INVITATION,
    shape: { invitationId: id, accept: z.boolean() },
  });

  /* ── Prospects ── */
  writeTool(server, {
    name: "assign_prospect",
    desc: "Assign a gym lead to a coach.",
    field: "assignProspect",
    args: "prospectId: ID!, coachId: ID!",
    select: "_id name status",
    shape: { prospectId: id, coachId: id },
  });
}
