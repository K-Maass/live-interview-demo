import type { MeetingProfile, ProfileId } from "../contracts";
// preparedIntents: two per profile, so a settled remote turn costs at most two speculative calls. The
// deep-lane reviews (checkConversation, checkObjectives) are not prepared: their hotkey runs on the deep
// lane anyway, so a fast speculative card would only be replaced.
export const meetingProfiles: Record<ProfileId, MeetingProfile> = {
  interview: {
    id: "interview",
    label: "Interview",
    automaticIntents: ["digDeeper", "checkObjectives", "checkConversation"],
    preparedIntents: ["digDeeper", "respond"],
    threshold: 0.72,
    steering: "active",
  },
  discovery: {
    id: "discovery",
    label: "Discovery",
    automaticIntents: [
      "digDeeper",
      "checkObjectives",
      "contribute",
      "checkConversation",
    ],
    preparedIntents: ["digDeeper", "contribute"],
    threshold: 0.72,
    steering: "active",
  },
  workClient: {
    id: "workClient",
    label: "Work / client meeting",
    automaticIntents: ["contribute", "checkConversation"],
    preparedIntents: ["contribute", "respond"],
    threshold: 0.85,
    steering: "selective",
  },
  presentationAnswering: {
    id: "presentationAnswering",
    label: "Presentation / answering",
    automaticIntents: ["respond", "checkConversation"],
    preparedIntents: ["respond", "contribute"],
    threshold: 0.8,
    steering: "responses",
  },
};
