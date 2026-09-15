import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { LoadingBlock } from "../components/Feedback";
import { AchievementActivity } from "../components/achievements/AchievementActivity";
import { useMobileViewport } from "../hooks/useMobileViewport";
import { HostedBoundary } from "../components/HostedBoundary";
import { useHosted } from "../hooks/useHosted";
import { HostedSetupBoundary } from "../components/setup/HostedSetupBoundary";

const CharacterLibraryPage = lazy(
  () => import("../pages/CharacterLibraryPage"),
);
const WelcomeEntryPage = lazy(() => import("../pages/WelcomeEntryPage"));
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
const MemoryLibraryPage = lazy(() => import("../pages/MemoryLibraryPage"));
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
const HostedAccountPage = lazy(() => import("../pages/HostedAccountPage"));
const HostedAdminPage = lazy(() => import("../pages/HostedAdminPage"));
const HostedSetupPage = lazy(() => import("../pages/HostedSetupPage"));
const ModelSettingsPage = lazy(() => import("../pages/ModelSettingsPage"));

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
  useMobileViewport();
  return (
    <HostedBoundary>
      <HostedSetupBoundary>
        <DearvaleRoutes />
      </HostedSetupBoundary>
    </HostedBoundary>
  );
}

function DearvaleRoutes() {
  const hosted = useHosted();
  if (hosted?.info.surface === "admin")
    return (
      <Suspense
        fallback={<LoadingBlock label="正在打开管理控制台…" fullPage />}
      >
        <Routes>
          <Route path="/admin/*" element={<HostedAdminPage />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Suspense>
    );
  return (
    <>
      <AchievementActivity />
      <Suspense fallback={<LoadingBlock label="正在打开 Dearvale…" fullPage />}>
        <Routes>
          <Route path="/" element={<Navigate to="/welcome" replace />} />
          <Route path="/welcome" element={<WelcomeEntryPage />} />
          {hosted ? (
            <Route path="/setup" element={<HostedSetupPage />} />
          ) : null}
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
            <Route path="/memory-library" element={<MemoryLibraryPage />} />
            <Route
              path="/characters/:characterId/memory-library"
              element={<MemoryLibraryPage />}
            />
            <Route
              path="/characters/:characterId/timeline"
              element={<TimelinePage />}
            />
            <Route path="/settings" element={<SettingsPage />} />
            {hosted ? (
              <Route path="/model-settings" element={<ModelSettingsPage />} />
            ) : null}
            {hosted ? (
              <Route path="/account" element={<HostedAccountPage />} />
            ) : null}
            <Route path="/achievements" element={<AchievementsPage />} />
            {!hosted ? (
              <Route path="/developer" element={<DeveloperPage />} />
            ) : null}
            <Route path="*" element={<Navigate to="/characters" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </>
  );
}
