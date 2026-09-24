import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GLOBAL_SCOPE,
  type AgentCapabilityLevel,
  type UserSkillRecord,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { useHostCollection } from "../../hooks/use-host-collection";
import {
  AgentCapabilityPage,
  AgentProjectPicker,
  CapabilityButton,
  CapabilityEmpty,
  CapabilityGroupHeader,
  CapabilityPanel,
  CapabilityRow,
  CapabilityRowMenu,
  CapabilityToggle,
  CapabilityToolbar,
  matchesCapabilitySearch,
  projectDisplayName,
  useAgentProjects,
  useArmedDelete,
  type CapabilityFilter,
  type CapabilityMenuItem,
} from "./AgentCapabilityLayout";
import {
  SkillEditorSheet,
  draftFromSkill,
  emptySkillDraft,
  type SkillDraft,
} from "./SkillEditorSheet";
import {
  IconArrowUpDown,
  IconBookOpen,
  IconDownload,
  IconFileText,
  IconFolderOpen,
  IconPencil,
  IconPlus,
  IconTrash,
} from "../icons";
import { PiSkillDiscoveryPanel } from "./PiSkillDiscoveryPanel";
import { SkillMarketPanel } from "./SkillMarketPanel";

import { TooltipButton } from "../ui";
const GLOBAL_SKILLS_PATH = "~/.agents/skills";

function projectSkillsPath(projectPath: string | null): string {
  return projectPath ? `${projectPath}/.agents/skills` : "<project-root>/.agents/skills";
}
/**
 * Host-core marks a skill imported with `mode: "link"` as `linked-import`: the
 * row lives inside a managed skills directory as a symlink, so its document
 * belongs to another directory while the row itself is ours to unlink.
 */
function isImportedLink(skill: UserSkillRecord): boolean {
  return skill.source === "linked-import";
}

type SkillEditorState = {
  draft: SkillDraft;
  editing: UserSkillRecord | null;
  level: AgentCapabilityLevel;
};

type SkillCollection = {
  global: UserSkillRecord[];
  project: UserSkillRecord[];
};

const EMPTY_SKILL_COLLECTION: SkillCollection = { global: [], project: [] };

export function AgentSkillsPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((state) => state.showToast);
  const { selectedProjectPath, setSelectedProjectPath, options } = useAgentProjects();
  const fetchSkills = useCallback(async (): Promise<SkillCollection> => {
    const [global, project] = await Promise.all([
      api.listUserSkills({
        level: "global",
        ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
      }),
      selectedProjectPath
        ? api.listUserSkills({ level: "project", projectPath: selectedProjectPath })
        : Promise.resolve({ skills: [] as UserSkillRecord[] }),
    ]);
    return { global: global.skills ?? [], project: project.skills ?? [] };
  }, [selectedProjectPath]);
  const {
    data: { global: globalSkills, project: projectSkills },
    setData: setSkills,
    loading,
    refreshing,
    reload: load,
  } = useHostCollection(fetchSkills, EMPTY_SKILL_COLLECTION, (error) =>
    showToast(error instanceof Error ? error.message : String(error), { variant: "error" }),
  );
  const [filter, setFilter] = useState<CapabilityFilter>("all");
  const [search, setSearch] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [editor, setEditor] = useState<SkillEditorState | null>(null);
  const [view, setView] = useState<"skills" | "market">("skills");
  const [saving, setSaving] = useState(false);
  const { armed, setArmed } = useArmedDelete();
  const [roots, setRoots] = useState<string[]>([]);
  const [rootsOpen, setRootsOpen] = useState(false);
  const [rootDraft, setRootDraft] = useState("");
  const [rootBusy, setRootBusy] = useState(false);

  const loadRoots = useCallback(async () => {
    try {
      const result = await api.listSkillRoots();
      setRoots(result.roots ?? []);
    } catch {
      // An unreachable host is already surfaced by the skills load.
      setRoots([]);
    }
  }, []);

  useEffect(() => {
    void loadRoots();
  }, [loadRoots]);

  /** How many listed skills came from one extra path, for that row's badge. */
  const skillsUnder = useCallback(
    (root: string) => {
      const prefix = `${root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()}/`;
      return globalSkills.filter((skill) =>
        skill.path.replace(/\\/g, "/").toLowerCase().startsWith(prefix),
      ).length;
    },
    [globalSkills],
  );

  const addRoot = async () => {
    const path = rootDraft.trim();
    if (!path || rootBusy) return;
    setRootBusy(true);
    try {
      const result = await api.addSkillRoot(path);
      setRoots(result.roots ?? []);
      setRootDraft("");
      setRootsOpen(false);
      await load();
      showToast(t("settings.skillRootAdded", { path }), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setRootBusy(false);
    }
  };

  const removeRoot = async (path: string) => {
    if (rootBusy) return;
    setRootBusy(true);
    try {
      const result = await api.removeSkillRoot(path);
      setRoots(result.roots ?? []);
      await load();
      showToast(t("settings.skillRootRemoved", { path }), { variant: "success" });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setRootBusy(false);
    }
  };

  const rowKey = (level: AgentCapabilityLevel, id: string) => `${level}:${id}`;

  const patchRow = (
    level: AgentCapabilityLevel,
    id: string,
    patch: Partial<UserSkillRecord>,
  ) => {
    setSkills((current) => ({
      ...current,
      [level]: current[level].map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  };

  const levelQuery = (level: AgentCapabilityLevel) => ({
    level,
    ...(selectedProjectPath ? { projectPath: selectedProjectPath } : {}),
  });

  /**
   * The switch flips locally first and only reverts if the host refuses, so one
   * row's request never blanks the list or freezes the others.
   */
  const toggle = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    if (busyId === key) return;
    const next = !skill.enabled;
    setBusyId(key);
    patchRow(level, skill.id, { enabled: next });
    try {
      await api.setUserSkillEnabled(skill.id, next, levelQuery(level));
      showToast(
        t(next ? "settings.capabilityEnabled" : "settings.capabilityDisabled", {
          name: skill.name || skill.id,
        }),
        { variant: "success" },
      );
    } catch (error) {
      patchRow(level, skill.id, { enabled: skill.enabled });
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  /** Where a new or imported skill lands: the filtered level, global when both. */
  const targetLevel: AgentCapabilityLevel = filter === "project" ? "project" : "global";

  const openCreate = () => {
    if (targetLevel === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setEditor({
      draft: {
        ...emptySkillDraft(),
        scope:
          targetLevel === "global"
            ? GLOBAL_SCOPE
            : { mode: "projects", projects: [selectedProjectPath!] },
      },
      editing: null,
      level: targetLevel,
    });
  };

  const openEdit = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    setBusyId(key);
    try {
      const result = await api.readUserSkill(skill.id, levelQuery(level));
      setEditor({
        draft: draftFromSkill(result.skill ?? skill, result.body ?? ""),
        editing: result.skill ?? skill,
        level,
      });
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const save = async () => {
    if (!editor) return;
    const { draft, editing, level } = editor;
    const projectPath = level === "project" ? selectedProjectPath ?? undefined : undefined;
    const payload = {
      name: draft.name.trim(),
      description: draft.description.trim(),
      body: draft.body,
      enabled: draft.enabled,
      scope: draft.scope,
      level,
      ...(projectPath ? { projectPath } : {}),
    };
    setSaving(true);
    try {
      if (editing) await api.updateUserSkill(editing.id, payload);
      else await api.createUserSkill(payload);
      await load();
      showToast(
        t(editing ? "settings.skillSaved" : "settings.skillCreated", { name: payload.name }),
        { variant: "success" },
      );
      setEditor(null);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    try {
      await api.revealUserSkill(skill.id, levelQuery(level));
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const remove = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    setBusyId(key);
    try {
      await api.removeUserSkill(skill.id, levelQuery(level));
      await load();
      showToast(
        t(
          isImportedLink(skill) ? "settings.skillUnlinkImportDone" : "settings.capabilityDeleted",
          { name: skill.name || skill.id },
        ),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
      setArmed(null);
    }
  };

  const importSkill = async (
    level: AgentCapabilityLevel = targetLevel,
    sourceKind: "file" | "dir" = "file",
  ) => {
    if (level === "project" && !selectedProjectPath) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    setBusyId(sourceKind === "dir" ? "import-dir" : "import");
    try {
      const result = await api.importUserSkill({
        level,
        sourceKind,
        ...(level === "project" && selectedProjectPath
          ? { projectPath: selectedProjectPath }
          : {}),
      });
      if (!result.canceled) {
        await load();
        if (result.skill) {
          showToast(t("settings.skillImported", { name: result.skill.name }), {
            variant: "success",
          });
        }
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const visible = useMemo(() => {
    const match = (skill: UserSkillRecord) =>
      matchesCapabilitySearch(search, skill.name, skill.id, skill.description);
    return {
      global: globalSkills.filter(match),
      project: projectSkills.filter(match),
    };
  }, [globalSkills, projectSkills, search]);

  const counts = {
    all: visible.global.length + visible.project.length,
    global: visible.global.length,
    project: visible.project.length,
  };

  const projectName = useMemo(
    () =>
      options.find((project) => project.path === selectedProjectPath)?.name ??
      (selectedProjectPath ? projectDisplayName(selectedProjectPath) : undefined),
    [options, selectedProjectPath],
  );

  /** Where a move sends a row, named the way the toast should say it. */
  const moveTarget: Partial<Record<AgentCapabilityLevel, string>> = {
    global: t("settings.globalLevel"),
    project: selectedProjectPath
      ? `${t("settings.projectLevel")} · ${projectName ?? projectDisplayName(selectedProjectPath)}`
      : undefined,
  };

  /**
   * Move one row to the other level. The project picker owns the destination,
   * so the same action reads "Move into <project>" on a global row and "Move to
   * Global" on a project one.
   *
   * The host moves the document rather than copying it, and a destination that
   * already holds the id or display name renames the arriving skill, so the
   * toast reports the new name instead of pretending the id survived.
   */
  const move = async (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    // Both link flavours are documents the app does not own: an extra-path
    // reference and a symlink placed inside a managed skills directory.
    if (skill.source === "linked" || isImportedLink(skill)) return;
    const to: AgentCapabilityLevel = level === "global" ? "project" : "global";
    const target = moveTarget[to];
    if (!target) {
      showToast(t("settings.selectProjectFirst"), { variant: "error" });
      return;
    }
    const key = rowKey(level, skill.id);
    setBusyId(key);
    try {
      const result = await api.transferUserSkill({
        id: skill.id,
        from: levelQuery(level),
        to: levelQuery(to),
      });
      await load();
      const name = skill.name || skill.id;
      const arrived = result.skill;
      showToast(
        arrived && arrived.id !== skill.id
          ? t("settings.capabilityMovedRenamed", {
              name,
              target,
              newName: arrived.name || arrived.id,
            })
          : t("settings.capabilityMoved", { name, target }),
        { variant: "success" },
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    } finally {
      setBusyId(null);
    }
  };

  const renderRow = (skill: UserSkillRecord, level: AgentCapabilityLevel) => {
    const key = rowKey(level, skill.id);
    const name = skill.name || skill.id;
    const busy = busyId === key;
    const isArmed = armed === key;
    // Both link flavours live outside this app's ownership, so neither opens
    // the editor and neither can move. An extra-path (`linked`) document is
    // read-only wholesale; a `linked-import` row is a symlink inside a managed
    // skills directory, so the row itself may still be unlinked.
    const linked = skill.source === "linked";
    const linkedImport = isImportedLink(skill);
    const linkOnly = linked || linkedImport;
    const items: CapabilityMenuItem[] = [
      {
        key: "reveal",
        label: t("extensions.skills.reveal"),
        icon: <IconFolderOpen size={14} />,
        onSelect: () => {
          setMenuFor(null);
          void reveal(skill, level);
        },
      },
      /**
       * A move needs a destination, so a global row offers it only while the
       * picker names a project; a project row always has Global to go back to.
       */
      ...(!linkOnly && moveTarget[level === "global" ? "project" : "global"]
        ? [
            {
              key: "move",
              label:
                level === "global"
                  ? t("settings.capabilityMoveToProject", {
                      project:
                        projectName ?? projectDisplayName(selectedProjectPath ?? ""),
                    })
                  : t("settings.capabilityMoveToGlobal"),
              icon: <IconArrowUpDown size={14} />,
              onSelect: () => {
                setMenuFor(null);
                void move(skill, level);
              },
            } satisfies CapabilityMenuItem,
          ]
        : []),
      ...(linked
        ? []
        : [
            {
              key: "remove",
              label: isArmed
                ? linkedImport
                  ? t("settings.skillUnlinkImportConfirm")
                  : t("settings.capabilityRemoveConfirm")
                : linkedImport
                  ? t("settings.skillUnlinkImport")
                  : t("extensions.skills.remove"),
              icon: <IconTrash size={14} />,
              danger: true,
              onSelect: () => {
                if (isArmed) {
                  setMenuFor(null);
                  void remove(skill, level);
                } else {
                  setArmed(key);
                }
              },
            } satisfies CapabilityMenuItem,
          ]),
    ];
    return (
      <CapabilityRow
        key={key}
        glyph={<IconBookOpen size={16} />}
        name={name}
        off={!skill.enabled}
        menuOpen={menuFor === key}
        badges={
          <>
            <span className="agent-capability-badge is-level">
              {level === "global"
                ? t("settings.capabilityFilterGlobal")
                : t("settings.capabilityFilterProject")}
            </span>
            {linked ? (
              <span className="agent-capability-badge">{t("settings.skillRootsBadge")}</span>
            ) : linkedImport ? (
              <span className="agent-capability-badge">
                {t("settings.importAgentScanModeLink")}
              </span>
            ) : skill.source === "imported" ? (
              <span className="agent-capability-badge">{t("settings.imported")}</span>
            ) : null}
          </>
        }
        description={skill.description || t("settings.noCapabilityDescription")}
        actions={
          <>
            {linkOnly ? null : (
              <TooltipButton
                type="button"
                className="settings-icon-button"
                ariaLabel={t("extensions.skills.rowActions", { name })}
                tooltip={t("extensions.skills.edit")}
                disabled={busy}
                onClick={() => void openEdit(skill, level)}
              >
                <IconPencil size={15} />
              </TooltipButton>
            )}
            <CapabilityRowMenu
              label={t("extensions.skills.rowActions", { name })}
              items={items}
              disabled={busy}
              open={menuFor === key}
              onOpenChange={(open) => {
                setMenuFor(open ? key : null);
                if (!open) setArmed(null);
              }}
            />
            <CapabilityToggle
              checked={skill.enabled}
              busy={busy}
              label={t("settings.toggleCapability", { name })}
              onChange={() => void toggle(skill, level)}
            />
          </>
        }
      />
    );
  };

  const showGlobal = filter !== "project";
  const showProject = filter !== "global";
  const newSkillTitle =
    targetLevel === "project"
      ? t("settings.capabilityCreateInProject")
      : t("settings.capabilityCreateInGlobal");
  const importButton = (level: AgentCapabilityLevel) => (
    <>
      <CapabilityButton
        busy={busyId === "import"}
        title={
          level === "project"
            ? t("settings.capabilityImportToProject")
            : t("settings.capabilityImportToGlobal")
        }
        onClick={() => void importSkill(level, "file")}
      >
        <IconDownload size={14} />
        {t("settings.importSkillFile")}
      </CapabilityButton>
      <CapabilityButton
        busy={busyId === "import-dir"}
        title={
          level === "project"
            ? t("settings.capabilityImportToProject")
            : t("settings.capabilityImportToGlobal")
        }
        onClick={() => void importSkill(level, "dir")}
      >
        <IconDownload size={14} />
        {t("settings.importSkillDir")}
      </CapabilityButton>
    </>
  );

  const marketButton = (
    <CapabilityButton
      onClick={() => setView("market")}
    >
      <IconFileText size={14} />
      {t("settings.sklm.browse")}
    </CapabilityButton>
  );

  if (view === "market") {
    return (
      <SkillMarketPanel
        installedIds={[...globalSkills, ...projectSkills].map((skill) => skill.id)}
        onBack={() => {
          setView("skills");
          void load();
        }}
        onInstalled={() => {
          setView("skills");
          void load();
        }}
      />
    );
  }

  return (
    <AgentCapabilityPage
      description={t("settings.skillsDescription")}
      note={t("settings.capabilityPriority")}
      toolbar={
        <CapabilityToolbar
          filter={filter}
          onFilterChange={setFilter}
          counts={counts}
          search={search}
          onSearchChange={setSearch}
          searchPlaceholder={t("extensions.skills.searchPlaceholder")}
          projectPicker={
            <AgentProjectPicker
              value={selectedProjectPath}
              options={options}
              label={t("settings.selectProject")}
              onChange={setSelectedProjectPath}
            />
          }
          actions={
            <>
              <CapabilityButton variant="primary" title={newSkillTitle} onClick={openCreate}>
                <IconPlus size={14} />
                {t("settings.newSkill")}
              </CapabilityButton>
              {marketButton}
            </>
          }
        />
      }
    >
      <PiSkillDiscoveryPanel />
      <CapabilityPanel
        loading={loading}
        refreshing={refreshing}
        loadingLabel={t("settings.loadingCapabilities")}
      >
        {counts.all === 0 && search.trim() ? (
          <CapabilityEmpty
            message={t("settings.capabilityNoMatches")}
            icon={<IconBookOpen size={18} />}
          />
        ) : (
          <>
            {showGlobal ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.globalLevel")}
                  path={GLOBAL_SKILLS_PATH}
                  count={visible.global.length}
                  action={importButton("global")}
                />
                {visible.global.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.skillsEmpty")}
                    icon={<IconBookOpen size={18} />}
                    action={
                      <CapabilityButton variant="primary" onClick={openCreate}>
                        <IconPlus size={14} />
                        {t("extensions.skills.add")}
                      </CapabilityButton>
                    }
                  />
                ) : (
                  visible.global.map((skill) => renderRow(skill, "global"))
                )}
                <CapabilityGroupHeader
                  label={t("settings.skillRoots")}
                  count={roots.length}
                  action={
                    <CapabilityButton
                      title={t("settings.skillRootsAdd")}
                      disabled={rootBusy}
                      onClick={() => setRootsOpen((open) => !open)}
                    >
                      <IconPlus size={14} />
                      {t("settings.skillRootsAdd")}
                    </CapabilityButton>
                  }
                />
                {rootsOpen ? (
                  <CapabilityRow
                    glyph={<IconPlus size={16} />}
                    name={t("settings.skillRootsAdd")}
                    description={t("settings.skillRootsHint")}
                    meta={
                      <div className="agent-capability-search-wrap">
                        <IconFolderOpen size={13} aria-hidden="true" />
                        <input
                          className="agent-capability-search"
                          type="text"
                          value={rootDraft}
                          spellCheck={false}
                          placeholder={t("settings.skillRootsPlaceholder")}
                          aria-label={t("settings.skillRootsPlaceholder")}
                          onChange={(event) => setRootDraft(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void addRoot();
                            }
                          }}
                        />
                      </div>
                    }
                    actions={
                      <CapabilityButton
                        variant="primary"
                        busy={rootBusy}
                        title={t("settings.skillRootsConfirm")}
                        onClick={() => void addRoot()}
                      >
                        {t("settings.skillRootsConfirm")}
                      </CapabilityButton>
                    }
                  />
                ) : null}
                {roots.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.skillRootsEmpty")}
                    hint={t("settings.skillRootsDesc")}
                    icon={<IconFolderOpen size={18} />}
                  />
                ) : (
                  roots.map((root) => (
                    <CapabilityRow
                      key={root}
                      glyph={<IconFolderOpen size={16} />}
                      name={root}
                      badges={
                        <span className="agent-capability-badge">
                          {t("settings.skillRootsCount", { count: skillsUnder(root) })}
                        </span>
                      }
                      description={t("settings.skillRootsRowDesc")}
                      actions={
                        <TooltipButton
                          type="button"
                          className="settings-icon-button"
                          ariaLabel={t("settings.skillRootsRemove", { path: root })}
                          tooltip={t("settings.skillRootsRemove", { path: root })}
                          disabled={rootBusy}
                          onClick={() => void removeRoot(root)}
                        >
                          <IconTrash size={15} />
                        </TooltipButton>
                      }
                    />
                  ))
                )}
              </>
            ) : null}
            {showProject ? (
              <>
                <CapabilityGroupHeader
                  label={t("settings.projectLevel")}
                  path={projectSkillsPath(selectedProjectPath)}
                  count={visible.project.length}
                  action={selectedProjectPath ? importButton("project") : undefined}
                />
                {!selectedProjectPath ? (
                  <CapabilityEmpty message={t("settings.selectProjectFirst")} />
                ) : visible.project.length === 0 ? (
                  <CapabilityEmpty
                    message={t("settings.skillsEmpty")}
                    icon={<IconBookOpen size={18} />}
                  />
                ) : (
                  visible.project.map((skill) => renderRow(skill, "project"))
                )}
              </>
            ) : null}
          </>
        )}
      </CapabilityPanel>

      {editor ? (
        <SkillEditorSheet
          draft={editor.draft}
          setDraft={(draft) => setEditor((current) => (current ? { ...current, draft } : current))}
          editing={editor.editing}
          saving={saving}
          level={editor.level}
          projectName={projectName}
          onClose={() => {
            if (!saving) setEditor(null);
          }}
          onSave={() => void save()}
          onReveal={
            editor.editing
              ? () => void reveal(editor.editing!, editor.level)
              : undefined
          }
        />
      ) : null}
    </AgentCapabilityPage>
  );
}
