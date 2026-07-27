import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfigDto,
  DonelApi,
  LauncherDefaultsDto,
  NotificationPreference,
  ProfileDoctorReportDto,
  ProfileHeadroomMap,
  ProfileSummaryDto,
  ProjectInfo,
  PtyCreateOptions,
  PtyCreateResult,
  PtyExitInfo,
  SemaphoreStateInfo,
  SemaphoreUpdate,
  SessionSummaryDto,
  TranscriptChangedPayload,
} from '../shared';
import {
  CONFIG_CHANNELS,
  PROFILE_CHANNELS,
  PROJECT_CHANNELS,
  PTY_CHANNELS,
  SEMAPHORE_CHANNELS,
  SESSION_CHANNELS,
  TRANSCRIPT_CHANNELS,
} from '../shared';
// T504 (005-terminal-copy-paste) — canal do clipboard-bridge (main), aditivo
// aos imports acima (não reordena o bloco existente).
import { CLIPBOARD_CHANNELS } from '../shared';

// contextIsolation: true + sem nodeIntegration (src/main/index.ts) — este
// arquivo é o único ponto por onde o renderer alcança o main process, via
// `window.donel.*` tipado de ponta a ponta (plan.md "Arquitetura de
// processos"). Canais `pty:*` chegam em T004; `projects:*` chega no T007;
// `sessions:*` chega no T013; `profiles:*` chega no T014; `config:*` chega
// no T015 (ConfigStore formal, FR-007/FR-009).

const donelApi: DonelApi = {
  pty: {
    create: (options: PtyCreateOptions) =>
      ipcRenderer.invoke(PTY_CHANNELS.create, options) as Promise<PtyCreateResult>,

    input: (ptyId: string, data: string) => {
      ipcRenderer.send(PTY_CHANNELS.input, ptyId, data);
    },

    resize: (ptyId: string, cols: number, rows: number) => {
      ipcRenderer.send(PTY_CHANNELS.resize, ptyId, cols, rows);
    },

    kill: (ptyId: string) => {
      ipcRenderer.send(PTY_CHANNELS.kill, ptyId);
    },

    getPreview: (ptyId: string) => ipcRenderer.invoke(PTY_CHANNELS.preview, ptyId) as Promise<string[]>,

    onData: (ptyId: string, listener: (data: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventPtyId: string, data: string): void => {
        if (eventPtyId === ptyId) listener(data);
      };
      ipcRenderer.on(PTY_CHANNELS.data, handler);
      return () => ipcRenderer.removeListener(PTY_CHANNELS.data, handler);
    },

    onExit: (ptyId: string, listener: (info: PtyExitInfo) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, eventPtyId: string, info: PtyExitInfo): void => {
        if (eventPtyId === ptyId) listener(info);
      };
      ipcRenderer.on(PTY_CHANNELS.exit, handler);
      return () => ipcRenderer.removeListener(PTY_CHANNELS.exit, handler);
    },
  },

  projects: {
    list: () => ipcRenderer.invoke(PROJECT_CHANNELS.list) as Promise<ProjectInfo[]>,

    setFavorite: (path: string, favorite: boolean) =>
      ipcRenderer.invoke(PROJECT_CHANNELS.favorite, path, favorite) as Promise<ProjectInfo[]>,
  },

  semaphore: {
    // Um canal IPC só (broadcast de todas as sessões) — filtrado por ptyId
    // aqui, mesmo padrão de pty.onData/pty.onExit acima.
    onUpdate: (ptyId: string, listener: (info: SemaphoreStateInfo) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, update: SemaphoreUpdate): void => {
        if (update.ptyId === ptyId) listener({ state: update.state, stateEnteredAt: update.stateEnteredAt });
      };
      ipcRenderer.on(SEMAPHORE_CHANNELS.update, handler);
      return () => ipcRenderer.removeListener(SEMAPHORE_CHANNELS.update, handler);
    },
  },

  sessions: {
    list: (projectPath: string) =>
      ipcRenderer.invoke(SESSION_CHANNELS.list, projectPath) as Promise<SessionSummaryDto[]>,
    // T406 (004) — grava/limpa o nome dado pela UI. `name` vazio apaga (C5).
    setName: (sessionId: string, name: string, seenTitle: string | null) =>
      ipcRenderer.invoke(SESSION_CHANNELS.setName, sessionId, name, seenTitle) as Promise<AppConfigDto>,

    // T412 (004) — push do watcher de transcript (CA-4). Sem filtro por
    // sessionId aqui, ao contrário de `pty.onData`: é UMA assinatura no App
    // para TODAS as abas vivas, e quem despacha por sessão é o renderer.
    onTranscriptChanged: (listener: (payload: TranscriptChangedPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: TranscriptChangedPayload): void => {
        listener(payload);
      };
      ipcRenderer.on(TRANSCRIPT_CHANNELS.changed, handler);
      return () => ipcRenderer.removeListener(TRANSCRIPT_CHANNELS.changed, handler);
    },

    // T705 (007-favoritos-sessoes) — os três canais de escrita do registro.
    registerVisit: (sessionId: string, projectPath: string, label: string) =>
      ipcRenderer.invoke(SESSION_CHANNELS.registerVisit, sessionId, projectPath, label) as Promise<AppConfigDto>,

    setPinned: (sessionId: string, pinned: boolean) =>
      ipcRenderer.invoke(SESSION_CHANNELS.setPinned, sessionId, pinned) as Promise<AppConfigDto>,

    forget: (sessionId: string) => ipcRenderer.invoke(SESSION_CHANNELS.forget, sessionId) as Promise<AppConfigDto>,

    // T710/CA-11 (2º momento) — o main confere o `.jsonl` antes de remover.
    forgetIfOrphan: (sessionId: string) => ipcRenderer.invoke(SESSION_CHANNELS.forgetIfOrphan, sessionId) as Promise<AppConfigDto>,

    // T706/CA-8 — a única leitura de disco da feature, guardada no main.
    seedProject: (projectPath: string) => ipcRenderer.invoke(SESSION_CHANNELS.seedProject, projectPath) as Promise<AppConfigDto>,
  },

  profiles: {
    list: () => ipcRenderer.invoke(PROFILE_CHANNELS.list) as Promise<ProfileSummaryDto[]>,

    create: (name: string) => ipcRenderer.invoke(PROFILE_CHANNELS.create, name) as Promise<ProfileSummaryDto[]>,

    activate: (slug: string) => ipcRenderer.invoke(PROFILE_CHANNELS.activate, slug) as Promise<ProfileSummaryDto[]>,

    doctor: (slug: string) => ipcRenderer.invoke(PROFILE_CHANNELS.doctor, slug) as Promise<ProfileDoctorReportDto>,

    repair: (slug: string) => ipcRenderer.invoke(PROFILE_CHANNELS.repair, slug) as Promise<ProfileDoctorReportDto>,

    // T205 — repassa `{ force }` cru pro main; o main é quem valida/normaliza
    // o payload (é IPC, não confia cegamente no que o renderer manda).
    headroom: (options?: { force?: boolean }) => ipcRenderer.invoke(PROFILE_CHANNELS.headroom, options) as Promise<ProfileHeadroomMap>,
  },

  config: {
    get: () => ipcRenderer.invoke(CONFIG_CHANNELS.get) as Promise<AppConfigDto>,

    setProjectRoots: (roots: string[]) => ipcRenderer.invoke(CONFIG_CHANNELS.setProjectRoots, roots) as Promise<AppConfigDto>,

    setNotificationPreference: (preference: NotificationPreference) =>
      ipcRenderer.invoke(CONFIG_CHANNELS.setNotificationPreference, preference) as Promise<AppConfigDto>,

    setLauncherDefaults: (defaults: LauncherDefaultsDto) =>
      ipcRenderer.invoke(CONFIG_CHANNELS.setLauncherDefaults, defaults) as Promise<AppConfigDto>,

    setCollapsedFavorites: (collapsed: string[]) =>
      ipcRenderer.invoke(CONFIG_CHANNELS.setCollapsedFavorites, collapsed) as Promise<AppConfigDto>,
  },

  // T504 (005-terminal-copy-paste) — clipboard-bridge do main atrás de IPC
  // (plan.md decisão 6: nunca `navigator.clipboard` no renderer).
  clipboard: {
    hasImage: () => ipcRenderer.invoke(CLIPBOARD_CHANNELS.hasImage) as Promise<boolean>,

    readText: () => ipcRenderer.invoke(CLIPBOARD_CHANNELS.readText) as Promise<string>,

    writeText: (text: string) => ipcRenderer.invoke(CLIPBOARD_CHANNELS.writeText, text) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld('donel', donelApi);
