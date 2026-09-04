import type {
  LetterDetailResponse,
  OpenLetterResponse,
} from "@personasim/contracts";
import {
  phaseAfterSuccessfulOpen,
  type LetterRevealPhase,
} from "./correspondence";

export async function persistThenSealLetter(input: {
  persistDraft: () => Promise<LetterDetailResponse>;
  sealDraft: (letterId: string) => Promise<LetterDetailResponse>;
}): Promise<LetterDetailResponse> {
  const persisted = await input.persistDraft();
  return input.sealDraft(persisted.letter.id);
}

/**
 * Hands decrypted content directly to the currently mounted reader. It does
 * not return that content and does not accept a QueryClient, preventing the
 * open response from being written to React Query by this flow.
 */
export async function openLetterForMountedReader(input: {
  open: () => Promise<OpenLetterResponse>;
  prefersReducedMotion: boolean;
  onOpened: (response: OpenLetterResponse, phase: LetterRevealPhase) => void;
}): Promise<void> {
  const response = await input.open();
  input.onOpened(
    response,
    phaseAfterSuccessfulOpen(input.prefersReducedMotion),
  );
}
