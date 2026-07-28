import { AccountBadge, Button, getHeadroomTier, Modal, TextInput } from '@donel-dev/design-system';
import { AlertTriangle, Check, ChevronDown } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProfileDoctorReportDto, ProfileHeadroomMap, ProfileQuota, ProfileSummaryDto } from '../../shared';
import { parseAccountNumber } from '../../shared';
import styles from './ProfileSwitcher.module.css';

// T014 — badge da conta ativa (titlebar) + dropdown de perfis (ui-spec §6,
// FR-005/FR-012, CA-3). Auto-suficiente de propósito: diferente de
// PreviousSessions (cujo fetch mora em App.tsx porque o resultado alimenta
// `addTab`), a troca de perfil não afeta NENHUM estado de aba já aberta
// (FR-005 — "trocar de perfil afeta apenas sessões novas"; o main process já
// aplica o perfil ativo em todo `pty:create` claude futuro, ver
// src/main/index.ts `activeProfileConfigDir`) — então este componente só
// precisa de `window.donel.profiles.*`, sem props vindas de App.tsx.
//
// `AccountBadge` (design-system) hardcoda o texto "Tecnologia Claude
// {accountNumber}" — não serve pra perfis com nome arbitrário (Principal,
// ou perfis de teste como "spike-test"/"e2e-profile-test", que o smoke desta
// task cria pra provar isolamento sem exigir login humano). `parseAccountNumber`
// (shared/profiles.ts) decide: nome bate com a convenção -> AccountBadge de
// verdade; senão -> rótulo genérico com o nome cru + `HeadroomSlot` (mesmas
// cores de tier — ver comentário do `HeadroomSlot` abaixo, fix rodada 4 item 8).

const EMPTY_PROFILES: ProfileSummaryDto[] = [{ name: 'Principal', slug: 'principal', isPrimary: true, active: true }];

/**
 * FIX (feedback E2E rodada 4, item 8) — CAUSA RAIZ REAL: `readQuotaAxiHeadroom`
 * (main/quota-headroom.ts) já ignorava o exit code do `quota-axi` (o
 * `close` handler nunca checou `code`, só o conteúdo de `stdout`) — essa
 * parte não estava quebrada (endurecida mesmo assim, ver comentário lá).
 * O bug real e 100% reproduzível estava AQUI: `parseAccountNumber` só
 * reconhece nomes "Tecnologia Claude {n}"; qualquer perfil fora dessa
 * convenção (INCLUINDO o perfil "Principal", que é o único que TODO
 * usuário tem por padrão) caía no branch de "nome genérico" — que nunca
 * renderizava headroom nenhum (nem `%`, nem `—`), nem no badge do
 * titlebar, nem na linha do dropdown, nem no rótulo da Statusbar. Como
 * "Principal" é o caso mais comum, a cota parecia não existir em lugar
 * nenhum ("descoberta hoje é difícil"). Fix: este slot SEMPRE renderiza
 * (percent ou "—", nunca omite a linha), reaproveitado nos dois branches
 * de nome genérico — módulo top-level (não inline no corpo de
 * ProfileSwitcher), mesma lição do fix da input da Tarefa 1.
 */
// T208 (CA-4) — badge do titlebar (perfil fora da convenção "Tecnologia
// Claude {n}") rotula a janela explicitamente ("5h 62%"), mesmo motivo do
// rótulo composto de `onActiveProfileLabelChange` abaixo: um `%` sozinho não
// diz qual janela é (spec.md problema 2). Usado SÓ pelo badge do titlebar —
// as linhas do dropdown usam `ProfileQuotaDetail` (T206), não este slot.
function HeadroomSlot({ percent, loading = false }: { percent: number | null; loading?: boolean }): React.JSX.Element {
  const tier = loading ? 'none' : getHeadroomTier(percent);
  return (
    <span className={[styles.headroomText, styles[`tier-${tier}`]].join(' ')} data-testid="profile-headroom-slot">
      {loading ? 'carregando…' : percent === null ? '—' : `5h ${percent}%`}
    </span>
  );
}

/**
 * T206 (CA-2) — formata `resetsAt` (ISO) de forma curta e legível: mesmo dia
 * do reset -> hora ("14:30"); dia diferente -> data curta ("31/07"). Puro,
 * sem I/O; ISO inválido/ausente -> `null` (chamador OMITE o trecho de reset,
 * nunca escreve "reset —" — instrução explícita da task).
 */
function formatResetsAt(resetsAt: string | null | undefined): string | null {
  if (!resetsAt) return null;
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) return null;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  return sameDay
    ? date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** T206 — texto de uma janela (`5h`/`semana`/`fable`): "{label} {percent}% livre[· reset {data}]"; janela ausente -> "{label} sem dado". */
function windowText(label: string, window: { percentRemaining: number; resetsAt: string | null } | null): string {
  if (!window) return `${label} sem dado`;
  const reset = formatResetsAt(window.resetsAt);
  return reset ? `${label} ${window.percentRemaining}% livre · reset ${reset}` : `${label} ${window.percentRemaining}% livre`;
}

interface ProfileQuotaDetailProps {
  quota: ProfileQuota | undefined;
  loading: boolean;
  expanded: boolean;
}

/**
 * T206/CA-2/CA-2b — bloco de cota por linha do dropdown: 5h é a PRIMÁRIA (com
 * barra colorida por tier), semana vem em texto compacto embaixo (sem barra
 * própria — decisão do Alexandre 2026-07-24), fable só aparece quando a linha
 * está expandida (gesto de chevron dedicado, nunca ativa a conta). `loading`
 * cobre tanto "dropdown nunca abriu" quanto a releitura do botão "Atualizar"
 * (T205) — nunca mostra "—" nesse estado (CA-1).
 */
function ProfileQuotaDetail({ quota, loading, expanded }: ProfileQuotaDetailProps): React.JSX.Element {
  if (loading) {
    return (
      <div className={styles.quotaDetail}>
        <span className={styles.quotaLoading} data-testid="profile-quota-fivehour">
          5h carregando…
        </span>
        <span className={styles.quotaLoading} data-testid="profile-quota-sevenday">
          semana carregando…
        </span>
      </div>
    );
  }

  if (!quota || quota.status !== 'ok') {
    return (
      <div className={styles.quotaDetail}>
        <span data-testid="profile-quota-fivehour">5h —</span>
        <span data-testid="profile-quota-sevenday">semana —</span>
      </div>
    );
  }

  const tier = getHeadroomTier(quota.fiveHour?.percentRemaining ?? null);
  const fiveHourPercentValue = quota.fiveHour?.percentRemaining ?? 0;

  return (
    <div className={styles.quotaDetail}>
      <div className={styles.fiveHourRow} data-testid="profile-quota-fivehour">
        {quota.fiveHour ? (
          <div className={styles.barTrack} aria-hidden="true">
            <div className={[styles.barFill, styles[`tier-${tier}`]].join(' ')} style={{ width: `${fiveHourPercentValue}%` }} />
          </div>
        ) : null}
        <span className={styles.fiveHourLabel}>{windowText('5h', quota.fiveHour)}</span>
      </div>
      <span className={styles.sevenDayText} data-testid="profile-quota-sevenday">
        {windowText('semana', quota.sevenDay)}
      </span>
      {expanded ? (
        <span className={styles.fableText} data-testid="profile-quota-fable">
          {windowText('fable', quota.fable)}
        </span>
      ) : null}
    </div>
  );
}

export interface ProfileSwitcherProps {
  /**
   * Reporta pra cima um rótulo pronto pra exibição ("Tecnologia Claude 3 ·
   * 62%" ou "Principal · —" quando o nome não segue a convenção — fix
   * rodada 4 item 8: o `%`/"—" agora entra SEMPRE, não só pro nome
   * convencional) — a Statusbar (ui-spec §2 zona 5: "conta ativa") não tem
   * acesso direto a `window.donel.profiles` (App.tsx não busca perfil
   * nenhum) e este componente já é quem faz esse fetch; evita duplicar a
   * chamada IPC só pra alimentar dois lugares.
   */
  onActiveProfileLabelChange?: (label: string) => void;
  /**
   * FIX (auditoria rodada 5, achado alta "regressão de cota") — reporta pra
   * cima o `ProfileHeadroomMap` INTEIRO (todos os perfis, não só o ativo)
   * toda vez que `window.donel.profiles.headroom()` resolve (FR-012, "leitura
   * sob demanda" — só quando o dropdown abre). App.tsx usa isto pra compor a
   * cota do perfil de NASCIMENTO da sessão em foco na Statusbar
   * (`computeSessionAccountLabel`, `shared/sessionAccountLabel.ts`), que pode
   * ser um perfil DIFERENTE do ativo global — por isso precisa do mapa
   * completo, não só de `activeHeadroom`.
   */
  onHeadroomChange?: (map: ProfileHeadroomMap) => void;
  /**
   * 003-modo-dev/T320 (CA-22) — SLUG do perfil ativo agora (não o rótulo
   * exibido). O Modo Dev compara esse slug com o `profileSlug` gravado em
   * cada etapa arquivada para avisar "essa etapa rodou na conta X". Mesmo
   * motivo dos dois callbacks acima: este componente já faz o fetch de
   * perfis; App.tsx não duplica a chamada só por um campo.
   */
  onActiveProfileSlugChange?: (slug: string) => void;
}

// T204 (002-quota-headroom) — `ProfileHeadroomMap` guarda `ProfileQuota`
// (status + 3 janelas), não mais `number|null`. Este componente NÃO é
// redesenhado nesta fase (isso é T206/T207) — só o MÍNIMO pra compilar e
// preservar o comportamento visual atual: deriva o percentual da 5h de cada
// `ProfileQuota` pra continuar alimentando `HeadroomSlot`/`AccountBadge`
// (que ainda só sabem mostrar um número). `status === 'loading'` cobre tanto
// "dropdown nunca abriu" (endpoint nunca chamado) quanto o próprio estado
// local `headroomLoading` já existente.
function fiveHourPercent(quota: ProfileQuota | undefined): number | null {
  if (!quota || quota.status !== 'ok') return null;
  return quota.fiveHour?.percentRemaining ?? null;
}

export function ProfileSwitcher({
  onActiveProfileLabelChange,
  onHeadroomChange,
  onActiveProfileSlugChange,
}: ProfileSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<ProfileSummaryDto[]>(EMPTY_PROFILES);
  const [headroom, setHeadroom] = useState<ProfileHeadroomMap>({});
  const [headroomLoading, setHeadroomLoading] = useState(false);
  const [doctorReports, setDoctorReports] = useState<Record<string, ProfileDoctorReportDto>>({});
  const [repairingSlug, setRepairingSlug] = useState<string | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [creating, setCreating] = useState(false);
  /** T206/CA-2b — linha expandida (revela `fable`); no máximo uma por vez, nunca ativa a conta. */
  const [expandedSlug, setExpandedSlug] = useState<string | null>(null);
  /** T205/CA-3 — releitura forçada (botão "Atualizar"), distinta de `headroomLoading` (1ª leitura da abertura) só pro texto do botão; ambas cobrem o mesmo `slotLoading` das linhas. */
  const [refreshing, setRefreshing] = useState(false);

  // FIX (auditoria rodada 5, achado baixa "callback de prop nas deps de
  // efeito") — App.tsx sempre passa os dois direto de `setState` (identidade
  // ESTÁVEL entre renders, contrato do React), então hoje não há bug
  // observável; mas um consumidor futuro passando uma arrow inline (nova
  // identidade a cada render do PAI) faria o efeito correspondente reagendar
  // a cada render do pai — e como os dois efeitos abaixo terminam chamando
  // de volta um `setState` do PAI (`setAccountLabel`/`setProfileHeadroom`
  // em App.tsx), esse reagendamento vira um ciclo: efeito roda -> chama o
  // callback -> pai re-renderiza -> nova identidade da arrow -> efeito roda
  // de novo. Mesmo padrão de `onStateChangeRef`/`onAliveChangeRef`/
  // `onProfileResolvedRef` em TerminalPane.tsx: guarda a versão MAIS
  // RECENTE do callback numa ref (atualizada a cada render, sem precisar
  // reassinar nada) e os efeitos abaixo leem `.current` em vez de terem o
  // callback na própria lista de dependências.
  const onActiveProfileLabelChangeRef = useRef(onActiveProfileLabelChange);
  onActiveProfileLabelChangeRef.current = onActiveProfileLabelChange;
  // 003-modo-dev/T320 — mesma razão do ref acima (fora da lista de deps).
  const onActiveProfileSlugChangeRef = useRef(onActiveProfileSlugChange);
  onActiveProfileSlugChangeRef.current = onActiveProfileSlugChange;
  const onHeadroomChangeRef = useRef(onHeadroomChange);
  onHeadroomChangeRef.current = onHeadroomChange;

  const refreshProfiles = useCallback((): void => {
    void window.donel.profiles.list().then(setProfiles);
  }, []);

  // Doctor por perfil não-Principal (Principal é sempre saudável,
  // profile-manager.ts) — reaproveitado tanto na abertura do dropdown quanto
  // logo após criar um perfil novo (senão o perfil recém-criado ficaria sem
  // status de doctor até o dropdown ser fechado e reaberto).
  const refreshDoctorFor = useCallback((profileList: readonly ProfileSummaryDto[]): void => {
    for (const profile of profileList) {
      if (profile.isPrimary) continue;
      void window.donel.profiles.doctor(profile.slug).then((report) => {
        setDoctorReports((prev) => ({ ...prev, [profile.slug]: report }));
      });
    }
  }, []);

  // Lista básica carregada no boot (badge do titlebar precisa saber quem é a
  // conta ativa mesmo com o dropdown fechado) — sem headroom/doctor ainda
  // (FR-012: "leitura sob demanda", nunca no boot).
  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  // FR-012 — dispara SÓ quando o dropdown abre: headroom (paralelo/timeout/
  // cache já resolvidos no main, ver quota-headroom.ts) + doctor por perfil.
  // `onHeadroomChange` lido via ref (ver comentário de topo do componente) —
  // fora da lista de deps de propósito, pra este efeito só reagir a `open`.
  useEffect(() => {
    if (!open) return;
    void window.donel.profiles.list().then((list) => {
      setProfiles(list);
      refreshDoctorFor(list);
    });
    setHeadroomLoading(true);
    void window.donel.profiles
      .headroom()
      .then((map) => {
        setHeadroom(map);
        onHeadroomChangeRef.current?.(map);
      })
      .finally(() => setHeadroomLoading(false));
  }, [open, refreshDoctorFor]);

  // T205 (US-C/CA-3) — botão "Atualizar": releitura ignorando o cache de 60s
  // (`{ force: true }`, ver quota-headroom.ts `HeadroomCache`/
  // `readAllProfilesHeadroom`). Reaproveita `slotLoading` das linhas (mesmo
  // "carregando…" da 1ª leitura) via `refreshing` — nenhuma linha some, só
  // volta a mostrar o estado de carregamento até a promise resolver.
  const handleRefreshHeadroom = useCallback((): void => {
    if (refreshing) return;
    setRefreshing(true);
    void window.donel.profiles
      .headroom({ force: true })
      .then((map) => {
        setHeadroom(map);
        onHeadroomChangeRef.current?.(map);
      })
      .finally(() => setRefreshing(false));
  }, [refreshing]);

  const handleActivate = (slug: string): void => {
    void window.donel.profiles.activate(slug).then(setProfiles);
  };

  const handleRepair = (slug: string): void => {
    setRepairingSlug(slug);
    void window.donel.profiles
      .repair(slug)
      .then((report) => setDoctorReports((prev) => ({ ...prev, [slug]: report })))
      .finally(() => setRepairingSlug(null));
  };

  const handleCreate = (): void => {
    const name = newProfileName.trim();
    if (!name || creating) return;
    setCreating(true);
    void window.donel.profiles
      .create(name)
      .then((list) => {
        setProfiles(list);
        setNewProfileName('');
        refreshDoctorFor(list); // perfil recém-criado já entra com status de doctor visível, sem precisar fechar/reabrir o dropdown.
        // CAUSA RAIZ (T206 CA-2b) — `headroom` só era populado no efeito de
        // abertura do dropdown (`[open, ...]`), então um perfil criado DEPOIS
        // dessa leitura nunca ganhava entrada no mapa dentro da mesma sessão
        // do dropdown: `quota` ficava `undefined` (nem "loading", nem "ok")
        // e `ProfileQuotaDetail` caía no branch de fallback ("5h —"/"semana
        // —") pra sempre — mesmo expandindo a linha, o fable nunca aparecia
        // (não é estado de loading, então `expandButton`/CA-2b não ajuda).
        // Fix: relê o headroom (com cache normal — não é o botão
        // "Atualizar", não precisa `force`) assim que o perfil novo entra na
        // lista, mesmo tratamento de `slotLoading` que a leitura inicial já
        // usa (sem essa chamada as linhas recém-criadas ficam "presas" em —
        // até o dropdown fechar e reabrir).
        setHeadroomLoading(true);
        void window.donel.profiles
          .headroom()
          .then((map) => {
            setHeadroom(map);
            onHeadroomChangeRef.current?.(map);
          })
          .finally(() => setHeadroomLoading(false));
      })
      .finally(() => setCreating(false));
  };

  // FIX (feedback E2E rodada 4, item 5) — CAUSA RAIZ REAL: não era refresh
  // periódico de quota nem input recriado (hipótese da auditoria) — o
  // ProfileSwitcher não tem NENHUM polling. O bug é o `onClose` do Modal:
  // antes era `() => setOpen(false)` inline, uma identidade NOVA a cada
  // render deste componente. Cada tecla digitada em "Novo perfil" chama
  // `setNewProfileName` -> re-render -> novo `onClose` -> o
  // `useEffect(..., [open, onClose])` do foco-trap do Modal.tsx
  // (design-system) enxerga a dependência mudar -> roda o cleanup (que
  // FOCA de volta o elemento anterior ao modal ter aberto) e reexecuta o
  // efeito (que foca `getFocusable()[0]` dentro do dialog) A CADA TECLA.
  // `getFocusable()[0]` é o botão/AccountBadge da PRIMEIRA linha de perfil
  // (a lista `<ul>` vem antes do form no JSX) — nunca o TextInput — por
  // isso o campo "desseleciona" a cada instante. Fix: estabilizar a
  // identidade de `onClose` com `useCallback` (nunca muda entre renders),
  // então o efeito de foco do Modal só roda quando `open` de fato muda.
  const handleCloseModal = useCallback((): void => setOpen(false), []);

  const activeProfile = profiles.find((profile) => profile.active) ?? profiles[0];
  const activeAccountNumber = activeProfile ? parseAccountNumber(activeProfile.name) : null;
  const activeHeadroom = activeProfile ? fiveHourPercent(headroom[activeProfile.slug]) : null;

  // FIX (feedback E2E rodada 4, item 8, parte c) — antes o `percentText` só
  // entrava no rótulo pra nomes que batiam a convenção "Tecnologia Claude
  // {n}"; pro caso mais comum ("Principal", sem convenção) o rótulo da
  // Statusbar nunca mostrava cota nenhuma. Agora o `percentText` (`%` ou
  // "—") entra SEMPRE, dando visibilidade da cota no rodapé mesmo pro
  // perfil default. `onActiveProfileLabelChange` lido via ref (ver
  // comentário de topo do componente) — fora da lista de deps de propósito.
  useEffect(() => {
    if (!activeProfile) return;
    // T208 (CA-4) — "5h" explícita antes do percentual (mesmo motivo do
    // `computeSessionAccountLabel`/`sessionAccountLabel.ts`): um `%` sozinho
    // não diz qual janela é. Sem leitura -> só "—" (nunca "5h —").
    const percentText = activeHeadroom === null ? '—' : `5h ${activeHeadroom}%`;
    const label =
      activeAccountNumber !== null
        ? `Tecnologia Claude ${activeAccountNumber} · ${percentText}`
        : `${activeProfile.name} · ${percentText}`;
    onActiveProfileLabelChangeRef.current?.(label);
    onActiveProfileSlugChangeRef.current?.(activeProfile.slug);
  }, [activeProfile, activeAccountNumber, activeHeadroom]);

  return (
    <>
      {/* `display: contents` — não participa do layout flex do titlebar como caixa própria; só serve de âncora estável pro smoke (T014), já que o filho alterna entre AccountBadge/botão genérico conforme `parseAccountNumber`. */}
      <span style={{ display: 'contents' }} data-testid="profile-switcher-trigger">
        {activeAccountNumber !== null ? (
          <AccountBadge accountNumber={activeAccountNumber} headroomPercent={activeHeadroom} expandable onClick={() => setOpen(true)} />
        ) : (
          <button type="button" className={styles.genericBadge} onClick={() => setOpen(true)}>
            <span>{activeProfile?.name ?? 'Perfil'}</span>
            <HeadroomSlot percent={activeHeadroom} />
          </button>
        )}
      </span>

      <Modal open={open} onClose={handleCloseModal} title="Perfis de conta">
        <div className={styles.body} data-testid="profile-switcher">
          <Button
            variant="secondary"
            className={styles.refreshButton}
            data-testid="profile-headroom-refresh"
            onClick={handleRefreshHeadroom}
            disabled={refreshing}
          >
            {refreshing ? 'Atualizando…' : 'Atualizar'}
          </Button>

          <ul className={styles.list}>
            {profiles.map((profile) => {
              const accountNumber = parseAccountNumber(profile.name);
              const quota = headroom[profile.slug];
              const percent = fiveHourPercent(quota);
              const doctor = doctorReports[profile.slug];
              const unhealthy = doctor ? !doctor.healthy : false;
              // T205 — durante a releitura forçada (`refreshing`), TODA linha
              // volta a "carregando…", mesmo as que já tinham entrada no mapa
              // (senão o botão "Atualizar" pareceria não fazer nada até a
              // promise resolver — CA-1 exige "carregando" nunca "—" também
              // aqui).
              const slotLoading = (headroomLoading && !(profile.slug in headroom)) || refreshing;
              const expanded = expandedSlug === profile.slug;

              const toggleExpanded = (event: React.MouseEvent): void => {
                // CA-2b — gesto de expansão é SEPARADO do de seleção: nunca
                // deixa o clique borbulhar pro `<button>` de ativação (seja o
                // `AccountBadge`, seja `.plainRow`), senão expandir a linha
                // ativaria a conta junto — o oposto do pedido.
                event.stopPropagation();
                event.preventDefault();
                setExpandedSlug((prev) => (prev === profile.slug ? null : profile.slug));
              };

              const expandButton = (
                <button
                  type="button"
                  className={styles.expandButton}
                  data-testid="profile-quota-expand"
                  aria-expanded={expanded}
                  aria-label={expanded ? 'Ocultar cota do Fable' : 'Mostrar cota do Fable'}
                  onClick={toggleExpanded}
                >
                  <ChevronDown
                    size={14}
                    strokeWidth={1.5}
                    className={expanded ? styles.chevronExpanded : undefined}
                    aria-hidden="true"
                  />
                </button>
              );

              return (
                <li key={profile.slug} className={styles.row} data-testid="profile-row" data-slug={profile.slug}>
                  {/* CA-2b: o chevron é SEMPRE irmão do controle de ativação, nunca filho dele — `AccountBadge`/`.plainRow` já são `<button>`, e botão dentro de botão é HTML inválido (o `stopPropagation` não salva isso). */}
                  <div className={styles.rowHeader}>
                    {accountNumber !== null ? (
                      <AccountBadge
                        accountNumber={accountNumber}
                        headroomPercent={percent}
                        loading={slotLoading}
                        active={profile.active}
                        onClick={() => handleActivate(profile.slug)}
                      />
                    ) : (
                      <button type="button" className={styles.plainRow} onClick={() => handleActivate(profile.slug)}>
                        <span className={styles.plainName}>{profile.name}</span>
                        {profile.active ? <Check size={14} strokeWidth={1.5} aria-hidden="true" /> : null}
                      </button>
                    )}
                    {expandButton}
                  </div>

                  <ProfileQuotaDetail quota={quota} loading={slotLoading} expanded={expanded} />

                  {doctor && unhealthy ? (
                    <div className={styles.doctorWarning} data-testid="profile-doctor-warning">
                      <span
                        className={styles.doctorWarningIcon}
                        role="img"
                        aria-label="Junctions com problema"
                        title="Junctions com problema"
                      >
                        <AlertTriangle size={14} strokeWidth={1.5} aria-hidden="true" />
                      </span>
                      <Button
                        variant="secondary"
                        onClick={() => handleRepair(profile.slug)}
                        disabled={repairingSlug === profile.slug}
                      >
                        {repairingSlug === profile.slug ? 'Recriando…' : 'Recriar links'}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className={styles.createForm}>
            <TextInput
              label="Novo perfil"
              value={newProfileName}
              onChange={(event) => setNewProfileName(event.target.value)}
              placeholder="ex.: Tecnologia Claude 4"
              onKeyDown={(event) => {
                if (event.key === 'Enter') handleCreate();
              }}
            />
            <Button variant="secondary" onClick={handleCreate} disabled={creating || !newProfileName.trim()}>
              {creating ? 'Criando…' : 'Criar perfil'}
            </Button>
          </div>

          <p className={styles.hint}>
            Trocar de perfil afeta só sessões novas — abas já abertas continuam com a conta que tinham. O login sempre acontece
            dentro do terminal (<code>/login</code>); o app nunca lê nem grava credenciais.
          </p>
        </div>
      </Modal>
    </>
  );
}
