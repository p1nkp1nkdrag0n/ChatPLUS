import type {
  CharacterCreationPreview,
  CharacterInterviewAnswers,
} from "@personasim/contracts";
import { request } from "./client";
import type { CharacterSpec } from "./types";

export interface InterviewQuestion {
  id: string;
  text: string;
}

export type InterviewPreview = CharacterCreationPreview;

export const interviewApi = {
  followUps: (answers: CharacterInterviewAnswers) =>
    request<{ questions: InterviewQuestion[] }>(
      "/api/characters/interview/follow-ups",
      {
        method: "POST",
        body: JSON.stringify({ answers }),
      },
    ),
  compile: (input: {
    answers: CharacterInterviewAnswers;
    requestId: string;
    characterId?: string;
    expectedVersion?: number;
  }) =>
    request<{ character: CharacterSpec; preview: InterviewPreview }>(
      "/api/characters/interview/compile",
      { method: "POST", body: JSON.stringify(input) },
    ),
  preview: (id: string) =>
    request<InterviewPreview>(
      `/api/characters/${encodeURIComponent(id)}/creation-preview`,
    ),
};
