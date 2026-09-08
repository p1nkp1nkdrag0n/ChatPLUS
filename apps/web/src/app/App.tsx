import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LoadingBlock } from "../components/Feedback";
import { ApplicationEntryTracker } from "../experience/ApplicationEntryTracker";
import { useMotionPreference } from "../hooks/useMotionPreference";

const AppShell = lazy(() =>
  import("../components/AppShell").then((module) => ({
    default: module.AppShell,
  })),
);
const MarketingPage = lazy(() => import("../marketing/MarketingPage"));
const StartPage = lazy(() => import("../experience/StartPage"));
const WelcomePage = lazy(() => import("../experience/WelcomePage"));
const EntryPage = lazy(() => import("../experience/EntryPage"));

const CharacterLibraryPage = lazy(
  () => import("../pages/CharacterLibraryPage"),
);
const CharacterGeneratorPage = lazy(
  () => import("../pages/CharacterGeneratorPage"),
);
const CharacterImportPage = lazy(() => import("../pages/CharacterImportPage"));
const CharacterEditorPage = lazy(() => import("../pages/CharacterEditorPage"));
const ChatPage = lazy(() => import("../pages/ChatPage"));
const TimelinePage = lazy(() => import("../pages/TimelinePage"));
const SettingsPage = lazy(() => import("../pages/SettingsPage"));
const DeveloperPage = lazy(() => import("../pages/DeveloperPage"));
const CorrespondenceMailboxPage = lazy(
  () => import("../pages/CorrespondenceMailboxPage"),
);
const LetterComposePage = lazy(() => import("../pages/LetterComposePage"));
const LetterDetailPage = lazy(() => import("../pages/LetterDetailPage"));
const CorrespondenceThreadPage = lazy(
  () => import("../pages/CorrespondenceThreadPage"),
);
const RelationshipArchivePage = lazy(
  () => import("../pages/RelationshipArchivePage"),
);
const KeepsakeCabinetPage = lazy(() => import("../pages/KeepsakeCabinetPage"));
const ArtifactDetailPage = lazy(() => import("../pages/ArtifactDetailPage"));
const ShareComposerPage = lazy(() => import("../pages/ShareComposerPage"));

export const CORRESPONDENCE_ROUTE_PATHS = [
  "/characters/:characterId/correspondence",
  "/characters/:characterId/correspondence/compose",
  "/letters/:letterId",
  "/correspondence/threads/:threadId",
] as const;

export const RELATIONSHIP_ARCHIVE_ROUTE_PATHS = [
  "/characters/:characterId/relationship-archive",
  "/characters/:characterId/keepsakes",
  "/keepsakes/:keepsakeId",
  "/characters/:characterId/relationship-share",
] as const;

export function App() {
  useMotionPreference();
  return (
    <Suspense fallback={<LoadingBlock label="正在打开 ChatPLUS…" fullPage />}>
      <Routes>
        <Route path="/about" element={<MarketingPage />} />
        <Route path="/start" element={<StartPage />} />
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/" element={<EntryPage />} />
        <Route element={<ApplicationEntryTracker />}>
          <Route element={<AppShell />}>
            <Route path="/characters" element={<CharacterLibraryPage />} />
            <Route path="/create" element={<CharacterGeneratorPage />} />
            <Route path="/import" element={<CharacterImportPage />} />
            <Route
              path="/characters/:characterId/edit"
              element={<CharacterEditorPage />}
            />
            <Route
              path="/characters/:characterId/chat"
              element={<ChatPage />}
            />
            <Route
              path={CORRESPONDENCE_ROUTE_PATHS[0]}
              element={<CorrespondenceMailboxPage />}
            />
            <Route
              path={CORRESPONDENCE_ROUTE_PATHS[1]}
              element={<LetterComposePage />}
            />
            <Route
              path={CORRESPONDENCE_ROUTE_PATHS[2]}
              element={<LetterDetailPage />}
            />
            <Route
              path={CORRESPONDENCE_ROUTE_PATHS[3]}
              element={<CorrespondenceThreadPage />}
            />
            <Route
              path={RELATIONSHIP_ARCHIVE_ROUTE_PATHS[0]}
              element={<RelationshipArchivePage />}
            />
            <Route
              path={RELATIONSHIP_ARCHIVE_ROUTE_PATHS[1]}
              element={<KeepsakeCabinetPage />}
            />
            <Route
              path={RELATIONSHIP_ARCHIVE_ROUTE_PATHS[2]}
              element={<ArtifactDetailPage />}
            />
            <Route
              path={RELATIONSHIP_ARCHIVE_ROUTE_PATHS[3]}
              element={<ShareComposerPage />}
            />
            <Route path="/timeline" element={<TimelinePage />} />
            <Route
              path="/characters/:characterId/timeline"
              element={<TimelinePage />}
            />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/developer" element={<DeveloperPage />} />
            <Route path="*" element={<Navigate to="/characters" replace />} />
          </Route>
        </Route>
      </Routes>
    </Suspense>
  );
}
