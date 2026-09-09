export function isStyleProfileConfirmed(profile = {}, executablePack = {}) {
  if (!profile?.id || profile.selectionStatus !== "confirmed") return false;

  const executablePackId = executablePack.id || profile.executableMasterPackId || "";
  const executablePackVersion = executablePack.version || profile.masterPackVersion || "";
  if (!executablePackId || !executablePackVersion) return false;

  const usesExecutablePack = profile.masterPackId === executablePackId;
  const usesLegacyStyleSpecificPack = profile.masterPackId === profile.id
    && (!profile.executableMasterPackId || profile.executableMasterPackId === executablePackId);

  return profile.styleLock === true
    && profile.masterPackLocked === true
    && (usesExecutablePack || usesLegacyStyleSpecificPack)
    && profile.masterPackVersion === executablePackVersion
    && profile.masterContract?.locked === true;
}

export function styleGenerationAction(deck = {}, pack = {}, executablePack = {}) {
  const selectedStyleId = String(pack?.id || "");
  const savedStyleId = String(deck?.styleProfile?.id || "");
  const sameConfirmedStyle = Boolean(selectedStyleId
    && selectedStyleId === savedStyleId
    && isStyleProfileConfirmed(deck?.styleProfile, executablePack));
  const hasExistingOutput = Boolean(deck?.image2RenderPlan?.pages?.length && (!deck?.styleProfile?.referenceBundleId || deck.image2RenderPlan.compiler));

  if (sameConfirmedStyle && hasExistingOutput) {
    return {
      mode: "resume",
      label: "返回编辑导出",
      busyLabel: "正在打开编辑导出"
    };
  }
  if (savedStyleId && selectedStyleId && savedStyleId !== selectedStyleId) {
    return {
      mode: "replace",
      label: "应用新风格并重新生成锚点",
      busyLabel: "正在应用新风格"
    };
  }
  return {
    mode: "generate",
    label: "确认风格并生成 PPT",
    busyLabel: "正在锁定风格"
  };
}

export function styleGenerationUiAction(deck = {}, pack = {}, executablePack = {}, activeTaskKind = "") {
  const expectedTaskKind = "image2-compile";
  if (activeTaskKind === expectedTaskKind) {
    return {
      mode: "running",
      label: "返回编辑导出",
      busyLabel: "正在打开编辑导出"
    };
  }
  return styleGenerationAction(deck, pack, executablePack);
}
