import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "../components/AppShell";
import { LoadingBlock } from "../components/Feedback";

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

export function App() {
  return (
    <Suspense fallback={<LoadingBlock label="正在打开 PersonaSim…" fullPage />}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/characters" replace />} />
          <Route path="/characters" element={<CharacterLibraryPage />} />
          <Route path="/create" element={<CharacterGeneratorPage />} />
          <Route path="/import" element={<CharacterImportPage />} />
          <Route
            path="/characters/:characterId/edit"
            element={<CharacterEditorPage />}
          />
          <Route path="/characters/:characterId/chat" element={<ChatPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route
            path="/characters/:characterId/timeline"
            element={<TimelinePage />}
          />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/developer" element={<DeveloperPage />} />
          <Route path="*" element={<Navigate to="/characters" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
