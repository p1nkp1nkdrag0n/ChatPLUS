import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { LoadingBlock } from "../components/Feedback";
import { AchievementActivity } from "../components/achievements/AchievementActivity";

const CharacterLibraryPage = lazy(
  () => import("../pages/CharacterLibraryPage"),
);
const LandingPage = lazy(() => import("../pages/LandingPage"));
const WelcomePage = lazy(() => import("../pages/WelcomePage"));
const ProductEntryPage = lazy(() => import("../pages/ProductEntryPage"));
const CharacterGeneratorPage = lazy(
  () => import("../pages/CharacterGeneratorPage"),
);
const CharacterPreviewPage = lazy(
  () => import("../pages/CharacterPreviewPage"),
);
const CharacterImportPage = lazy(() => import("../pages/CharacterImportPage"));
const CharacterEditorPage = lazy(() => import("../pages/CharacterEditorPage"));
const ChatPage = lazy(() => import("../pages/ChatPage"));
const TimelinePage = lazy(() => import("../pages/TimelinePage"));
const SettingsPage = lazy(() => import("../pages/SettingsPage"));
const DeveloperPage = lazy(() => import("../pages/DeveloperPage"));
const AchievementsPage = lazy(() => import("../pages/AchievementsPage"));
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
  return (
    <>
      <AchievementActivity />
      <Suspense fallback={<LoadingBlock label="正在打开 Dearvale…" fullPage />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/welcome" element={<WelcomePage />} />
          <Route path="/create" element={<CharacterGeneratorPage />} />
          <Route
            path="/characters/:characterId/preview"
            element={<CharacterPreviewPage />}
          />
          <Route element={<AppShell />}>
            <Route path="/chat" element={<ProductEntryPage kind="chat" />} />
            <Route
              path="/mailbox"
              element={<ProductEntryPage kind="mailbox" />}
            />
            <Route path="/characters" element={<CharacterLibraryPage />} />
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
            <Route path="/achievements" element={<AchievementsPage />} />
            <Route path="/developer" element={<DeveloperPage />} />
            <Route path="*" element={<Navigate to="/characters" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
