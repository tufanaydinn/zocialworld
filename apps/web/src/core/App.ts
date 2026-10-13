import * as THREE from "three";
import { Renderer } from "./Renderer.ts";
import { GameLoop } from "./GameLoop.ts";
import { InputManager } from "../input/InputManager.ts";
import { AssetManager } from "../assets/AssetManager.ts";
import { CollisionSystem } from "../collision/CollisionSystem.ts";
import { InteractionSystem } from "../interaction/InteractionSystem.ts";
import { ThirdPersonCamera } from "../camera/ThirdPersonCamera.ts";
import { LocalPlayer } from "../player/LocalPlayer.ts";
import { PlayerController } from "../player/PlayerController.ts";
import { World } from "../world/World.ts";
import { HUD } from "../ui/HUD.ts";
import { InteractionPrompt } from "../ui/InteractionPrompt.ts";
import { ProjectDiscoveryPanel } from "../projects/ProjectDiscoveryPanel.ts";
import { DebugStats } from "../ui/DebugStats.ts";
import { WorldHud } from "../ui/WorldHud.ts";
import { LoadingOverlay } from "../ui/LoadingOverlay.ts";
import { CommunityClient, GRANTS_CATEGORY_ID } from "../community/CommunityClient.ts";
import { CommunityPanel } from "../community/CommunityPanel.ts";
import { WalletPanel } from "../zcash/WalletPanel.ts";
import { PaymentFlow } from "../zcash/PaymentFlow.ts";
import { ZcashWalletAdapter, __walletPolicyTestSeam, getWalletState } from "../zcash/ZcashWalletAdapter.ts";
import { __testSeam as walletEngineTestSeam } from "../zcash/core/wallet.ts";
import { ZCASH_NETWORK } from "../zcash/core/wallet-types.ts";
import { parseFeeUsd } from "../zcash/feeLabel.ts";
import { UpdatePrompt } from "./updatePrompt.ts";
import { PortalPanel } from "../ui/PortalPanel.ts";
import { LearningPanel } from "../learning/LearningPanel.ts";
import { LearningProgress } from "../learning/progress.ts";
import type { MinimapData } from "../ui/minimapTypes.ts";
import type { PortalDestination } from "../world/destinations.ts";
import { content as configuredContent } from "@zw/content";
import { content as sampleContent } from "../content/sample/index.ts";
import type { ContentProvider } from "../content/types.ts";
import { HALL_DESTINATION_ID, HALL_EXIT_DESTINATION_ID, type WatchHallCallbacks, type WatchHallHandles } from "../world/hall/contract.ts";
import { hallAnchors, mergeAnchors, type AnchorMap } from "../debug/anchors.ts";
import { PROJECTS } from "../projects/projectData.ts";
import { ConnectionStatus } from "../ui/ConnectionStatus.ts";
import { NameplateManager } from "../ui/Nameplates.ts";
import { NetworkClient } from "../networking/NetworkClient.ts";
import { RemotePlayerManager } from "../networking/RemotePlayerManager.ts";
import { HALL_PLACEHOLDER_LIFT } from "../networking/RemotePlayer.ts";
import { getWebSocketUrl } from "../networking/config.ts";
import { SocialStore } from "../social/SocialStore.ts";
import { PlayerContextCard } from "../social/PlayerContextCard.ts";
import { NicknameControls } from "../social/NicknameControls.ts";
import { SOCIAL_INTERACTION_RADIUS_METERS } from "../social/nearby.ts";
import { VoiceSession } from "../voice/VoiceSession.ts";
import { VoiceControls } from "../voice/VoiceControls.ts";
import { VoiceNotConnectedError, browserVoiceEnvironment, classifyVoiceFailure, voiceFailureMessage, type VoiceFailureStage, type VoiceMessageContext } from "../voice/voiceErrors.ts";
import { getParticipationCapabilities, isWalletHolder, subscribeToCapabilities, subscribeToWalletHolder } from "../zcash/participation.ts";
import { subscribeToWalletState } from "../zcash/ZcashWalletAdapter.ts";
import { OnboardingFlow, type OnboardingResult } from "../onboarding/OnboardingFlow.ts";
import { createCharacterPreview } from "../onboarding/CharacterPreview.ts";
import { NameConfirmationSwitch, disabledNameConfirmation, immediateNameConfirmation } from "../onboarding/nameConfirmation.ts";
import { FeeNameConfirmation } from "../onboarding/feeNameConfirmation.ts";
import { nicknameKey } from "../onboarding/nicknameRules.ts";
import { activeNameKey, subscribeToNameKey } from "../zcash/nameKey.ts";
import { claimTestCoins } from "../zcash/faucetClient.ts";
import { gameServerOrigin } from "./serverOrigin.ts";
import { loadProfile, profileAfterEntering, saveProfile, type PlayerProfile } from "../onboarding/profileStore.ts";
import { avatarColor, avatarColorCss } from "../player/avatarPalette.ts";
import { bindVoiceParticipation } from "../voice/VoiceParticipation.ts";
import { HallStore, hallStoreFeed } from "../hall/HallStore.ts";
import { StageSystem } from "../hall/StageSystem.ts";
import { StageWidget } from "../hall/StageWidget.ts";
import { DiscussionMenu } from "../hall/DiscussionMenu.ts";
import { SpeakerCardPanel, type SpeakerCardView } from "../hall/SpeakerCardPanel.ts";
import { HallBoards, type HallBoardsSnapshot } from "../hall/HallBoards.ts";
import { buildHallPeople, hallMemberCount, type HallPerson } from "../hall/hallPeople.ts";
import { proxiedImage } from "../community/safeHtml.ts";
import { WatchClient } from "../watch/WatchClient.ts";
import { WatchPanel, type WatchStageInfo, type WatchTab } from "../watch/WatchPanel.ts";
import { PersonalPlayer } from "../watch/PersonalPlayer.ts";
import { hallContains } from "../world/hall/hallGeometry.ts";
import { GUEST_NICKNAME_PATTERN, WATCH_HALL_EXIT_MARGIN_METERS, type PlayerAvatar, type PlayerAvatarModel } from "@project/shared";
import { SEATED_TARGET_HEIGHT, SeatSystem } from "../hall/SeatSystem.ts";
import { HallPresence } from "../hall/HallPresence.ts";
import { EmoteController } from "../social/Emotes.ts";
import { FloatingReactions } from "../social/FloatingReactions.ts";
import { RemoteAvatarLibrary } from "../networking/remoteAvatars.ts";
import { locationAt } from "../world/locations.ts";
import { HallPerfScene, PerfProbe, perfFixedDelta, perfSceneKind, type PerfSceneKind } from "./perfScene.ts";
import { KeyDialog, MODERATOR_KEY_TEXT } from "../hall/StageWidget.ts";
import { ModerationStore } from "../moderation/ModerationStore.ts";
import { ModerationPanel } from "../moderation/ModerationPanel.ts";
import { ReportDialog } from "../moderation/ReportDialog.ts";
import { ModerationActionDialog, type ModerationTargetRef, type ModerationVerb } from "../moderation/ModerationActionDialog.ts";
import { RemovedOverlay } from "../moderation/RemovedOverlay.ts";
import { LOCATION_LABELS, REPORT_REASON_LABELS, actionDoneText, actionErrorText, mutedRepeatText, mutedText, removedText } from "../moderation/format.ts";
import type { HallErrorReason, ModActionMessage, ModCloseReason, ModerationServerMessage } from "@project/shared";

/** Nameplate/bubble id for the local player's own chat bubble (remote ids are server playerIds). */
const LOCAL_BUBBLE_ID = "local-player";

interface PhotoPose {
  readonly position: [number, number, number];
  readonly target: [number, number, number];
  readonly fov?: number;
}

/**
 * Top-level composition root.
 *
 * App wires every system together but contains almost no logic of its
 * own — it creates each module, hands the handful of cross-cutting
 * dependencies between them (e.g. "the camera needs the world's
 * obstacle list", "the player controller needs the camera's yaw"), and
 * drives them from one GameLoop. Extending a single
 * system (camera, player, world, UI, networking) should not need to
 * touch this file except to add one new wiring line.
 *
 * See docs/architecture/OVERVIEW.md for the full data-flow diagram.
 */
export class App {
  private readonly container: HTMLElement;
  private readonly renderer: Renderer;
  private readonly input: InputManager;
  private readonly assetManager = new AssetManager();
  private readonly collisions = new CollisionSystem();
  private readonly interactions = new InteractionSystem();
  private readonly camera: ThirdPersonCamera;
  private readonly localPlayer = new LocalPlayer();
  private readonly playerController: PlayerController;
  /** What the world shows: the configured content, or the sample content with `?world=prototype` (comparison and debugging). */
  private readonly content: ContentProvider =
    new URLSearchParams(window.location.search).get("world") === "prototype" ? sampleContent : configuredContent;
  private readonly world: World;
  private readonly hud: HUD;
  /** What the hall's wh-* interactables do (the Watch panel, the Discussion menu, the speaker card, the stage). */
  private readonly watchHallActions: WatchHallCallbacks = {
    onOpenWatch: () => this.openWatchPanel(),
    onOpenDiscussion: () => this.discussionMenu.open(),
    onOpenSpeakerCard: () => this.speakerCard.open(),
    onPodium: () => this.stage.podium(),
    onExit: () => this.travelToId(HALL_EXIT_DESTINATION_ID),
    onOpenPortal: () => this.portalPanel.open(),
  };

  private readonly interactionPrompt: InteractionPrompt;
  private readonly projectDiscoveryPanel: ProjectDiscoveryPanel;
  private readonly debugStats: DebugStats | null;
  private readonly worldHud: WorldHud;
  private readonly communityClient = new CommunityClient();
  private readonly communityPanel: CommunityPanel;
  /** The Watch catalogue (live, schedule, replays) and the opt-in personal YouTube player. */
  private readonly watchClient = new WatchClient();
  private readonly watchPanel: WatchPanel;
  private readonly personalPlayer: PersonalPlayer;
  /** The last stage entry handed to the Watch panel (it re-renders only when this changes). */
  private watchStageKey = "";
  private readonly walletPanel: WalletPanel;
  private readonly paymentFlow: PaymentFlow;
  /** The stage: big screen, holder share flow, watch mode. */
  private readonly stage: StageSystem;
  /** The hall's social UI (docs/architecture/WATCH_HALL.md) — stage widget, Discussion Corner menu, speaker card — and the board feeds. */
  private readonly stageWidget: StageWidget;
  private readonly discussionMenu: DiscussionMenu;
  private readonly speakerCard: SpeakerCardPanel;
  private readonly hallBoards: HallBoards;
  /** The emote wheel's reactions sub-wheel, once that system registers it (Discussion Corner → Live Chat & Reactions). */
  private openHallReactions: (() => void) | null = null;
  /** The last speaker-card view handed to the panel and its HUD chip (they re-render only when it changes). */
  private speakerCardKey = "";
  private discussionRefreshTimer = 0;
  /** The 60 hall seats (E to sit, WASD to stand). */
  private readonly seats: SeatSystem;
  /** Hall state on avatars and nameplates (seated, raised hands, badges, plate policy, floating reactions). */
  private readonly hallPresence: HallPresence;
  /** The emote wheel (hold G), keys 1–8 / H in the hall, the 😀 button. */
  private readonly emotes: EmoteController;
  private readonly floatingReactions: FloatingReactions;
  private readonly portalPanel: PortalPanel;
  private readonly learningProgress = new LearningProgress(this.content.lessonCatalog.lessons.map((lesson) => lesson.id));
  private readonly learningPanel: LearningPanel;
  private shownMap: MinimapData | null = null;
  /** Resolves when streamed world content is in the scene AND its shaders are compiled. */
  private readonly worldReadyAndWarm: Promise<void>;
  private readonly connectionStatus: ConnectionStatus | null;

  private readonly nameplates: NameplateManager;
  private readonly localHead = new THREE.Vector3();
  /** The local bubble anchor and the reactions' head lookup, built once instead of every frame. */
  private readonly localBubbleAnchor = [{ id: LOCAL_BUBBLE_ID, headPosition: this.localHead }];
  private readonly reactionHead = new THREE.Vector3();
  private readonly reactionAnchor = (playerId: string): THREE.Vector3 | null => {
    if (playerId === LOCAL_BUBBLE_ID) return this.localHead;
    return this.remotePlayers.getPlayer(playerId)?.headPositionInto(this.reactionHead) ?? null;
  };
  /** The container's size, read at startup and on resize only (render() must not read layout after DOM writes). */
  private viewportWidth: number;
  private viewportHeight: number;
  private readonly remotePlayers: RemotePlayerManager;
  private readonly network: NetworkClient;
  private transformPublishTimer = 0;
  private transformSeq = 0;

  private readonly socialStore = new SocialStore();
  /** The server's Watch Hall state for this session (stage, seats, hands, floor, hosts). */
  private readonly hallStore = new HallStore();
  /** Moderation (ADR-019): moderator role, reports, log, bans/mutes, Moderator tags, this session's mute. */
  private readonly moderationStore = new ModerationStore();
  private readonly moderationPanel: ModerationPanel;
  private readonly removedOverlay: RemovedOverlay;
  private reportDialog: ReportDialog | null = null;
  private moderationDialog: ModerationActionDialog | null = null;
  private moderatorKeyDialog: KeyDialog | null = null;
  /** The duration of the last action this moderator sent (mod_action_result doesn't echo it). */
  private lastModAction: { readonly action: string; readonly durationMs: number | null | undefined } | null = null;
  /** Why the server closed this connection on purpose (kicked / banned / too many), until the player tries again. */
  private serverClosed: ModCloseReason | null = null;
  private wasModerator = false;
  private readonly playerContextCard: PlayerContextCard;
  private readonly nicknameControls: NicknameControls;
  private localPlayerId: string | null = null;
  /** The local player's nickname (from welcome / nickname_updated), for the Watch panel's stage entry. */
  private localNickname = "";
  /** Owner-only, from `welcome` — the only thing `enableVoice()` ever sends to `/voice/token`. Never a client-asserted playerId/nickname — see VoiceSession.enableVoice()'s docstring. */
  private voiceCapability: string | null = null;
  /** What the player last tried (the voice error card's "Try again" repeats it). */
  private lastVoiceAttempt: "talk" | "listen" = "talk";
  private readonly nearbyPlayerIds = new Set<string>();

  private readonly voiceSession: VoiceSession;
  private readonly voiceControls: VoiceControls;
  private pushToTalkWasPressed = false;
  private unsubscribeVoiceParticipation: (() => void) | null = null;
  /** Last time a guest pressing push-to-talk in listen mode was told why nothing happens (throttle). */
  private guestTalkHintAt = 0;

  // Identity (ADR-015): wallet holders and guests, onboarding before join, the chosen character.
  /** The start-of-game flow and the mid-session "Change character" / "Change name" modals. */
  private readonly onboarding: OnboardingFlow;
  /** What this device remembers (character; name for holders) — profileStore, try/catch storage. */
  private profile: PlayerProfile | null;
  /**
   * How a holder's chosen name is applied, by what the server runs (GET /zcash/info → names): ADR-015's honour system
   * (set_nickname) without a registry, ADR-016's fee-confirmed registration with one, or none while it is disabled.
   */
  private readonly nameConfirmation: NameConfirmationSwitch;
  /** ADR-016: the fee flow, once the server says it runs a registry (it receives every name_* message). */
  private feeNames: FeeNameConfirmation | null = null;
  /** Resolves once the server's name mode is known (or could not be fetched). */
  private nameModeReady: Promise<void> = Promise.resolve();
  private nameModeKnown = false;
  /** This server's payment rules (GET /zcash/info → payments, ADR-018), null until known. */
  private paymentInfo: { readonly feeZat: number; readonly capZat: number | null; readonly feeUsd: number | null } | null = null;
  /** "Update ready — reload", between actions only (ADR-018). */
  private readonly updatePrompt: UpdatePrompt;
  /** One KayKit template per model, shared by the onboarding preview, the local player and (high tier) remote players. */
  private readonly avatarLibrary: RemoteAvatarLibrary;
  /** The local player's server-accepted look (null until known). */
  private localAvatar: PlayerAvatar | null = null;
  /** The model the local player shows / is loading (avoids reloading the same one). */
  private localModelWanted: PlayerAvatarModel | null = null;
  /** The server-confirmed wallet-holder flag of this session (`welcome` / `can_receive_updated`). */
  private localCanReceive = false;
  /** A holder's name chosen in onboarding, applied through NameConfirmation once the join is welcomed. */
  private pendingName: string | null = null;
  /** The last name this client asked for, to say so when the server gave a suffixed one. */
  private requestedName: string | null = null;
  /** The first welcome of this page was handled (reconnects don't repeat the guest hint). */
  private welcomedOnce = false;
  private unsubscribeWalletHolder: (() => void) | null = null;

  private readonly gameLoop: GameLoop;
  /** DEV-only free camera for screenshots (`window.__setPhotoCamera`) — never set in production builds. */
  private photoCamera: THREE.PerspectiveCamera | null = null;
  /** DEV / VITE_TEST_HOOKS builds with `?perf=…` only: the frame probe and the synthetic hall crowd. */
  private readonly perf: PerfProbe | null;
  private readonly perfFixedDelta: number;
  private perfScene: HallPerfScene | null = null;

  /** Network transforms publish at ~10 Hz, not render FPS — see docs/protocols/multiplayer-protocol.md § Network rate. */
  private static readonly TRANSFORM_PUBLISH_INTERVAL_SECONDS = 0.1;

  constructor(container: HTMLElement) {
    this.container = container;
    const testHooks = import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === "1";
    const perfKind = testHooks ? perfSceneKind(window.location.search) : null;
    this.perf = perfKind ? new PerfProbe() : null;
    this.perfFixedDelta = perfKind ? perfFixedDelta(window.location.search) : 0;

    this.renderer = new Renderer(container);
    this.viewportWidth = container.clientWidth;
    this.viewportHeight = container.clientHeight;
    this.input = new InputManager(this.renderer.domElement);
    this.camera = new ThirdPersonCamera(container.clientWidth / container.clientHeight);

    // HUD is self-contained DOM chrome; the Watch Hall retitles its corner card (below).
    this.hud = new HUD(container);
    this.interactionPrompt = new InteractionPrompt(container);
    this.projectDiscoveryPanel = new ProjectDiscoveryPanel(container);
    this.communityPanel = new CommunityPanel(container, this.communityClient);
    // "Watch here" is the only path to YouTube, behind the player's consent dialog.
    this.personalPlayer = new PersonalPlayer(container, {
      focusGame: () => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        this.renderer.domElement.focus({ preventScroll: true });
      },
    });
    this.watchPanel = new WatchPanel(container, this.watchClient, {
      onWatchHere: (video) => {
        this.watchPanel.close();
        this.watchHere(video);
      },
      onGoToHall: () => this.travelToId(HALL_DESTINATION_ID),
    });
    // The player's own wallet (create/restore/unlock). Detecting an existing
    // locked wallet is a localStorage check — the 60 MB wallet engine only loads on create/unlock.
    this.walletPanel = new WalletPanel(container, {
      openFaucetGuide: () => this.communityPanel.openWikiArticle("site/Using_Zcash/Faucets.md"),
      // The owner-only session capability from `welcome` proves a live session to the faucet.
      getCapability: () => this.voiceCapability,
      // A guest who just connected a wallet is asked for a name once the panel (and its seed phrase) is closed.
      onClose: () => this.promptForNameIfPending(),
    });
    void this.walletPanel.initialize();
    this.portalPanel = new PortalPanel(container, this.content.destinations, (destination) => this.travelTo(destination));
    this.learningPanel = new LearningPanel(container, this.content.lessonCatalog, this.content.visualizers, this.learningProgress, this.communityClient, (view) => this.communityPanel.open(view));
    this.interactions.onNearestChange((nearest) => {
      if (nearest) this.interactionPrompt.show(nearest.label);
      else this.interactionPrompt.hide();
    });

    this.world = new World({
      collisions: this.collisions,
      interactions: this.interactions,
      assets: this.assetManager,
      quality: this.renderer.quality,
      onOpenProjectBoard: () => this.projectDiscoveryPanel.open(),
      onSelectProject: (projectId) => this.projectDiscoveryPanel.openProject(projectId),
      onOpenCommunity: (view) => this.communityPanel.open(view),
      onOpenPortal: () => this.portalPanel.open(),
      onTravel: (destinationId) => this.travelToId(destinationId),
      learning: this.learningProgress,
      onOpenLesson: (lessonId, step) => this.learningPanel.open(lessonId, step),
      onOpenLearningDirectory: (tier) => this.learningPanel.openDirectory(tier),
      watchHall: this.watchHallActions,
      content: this.content,
    });
    this.world.onLocationChange((location) => {
      this.refreshTitleCard();
      this.localPlayer.setHallLift(location === "hall", HALL_PLACEHOLDER_LIFT);
    });
    this.fillCommunityBoards();
    this.camera.setObstacles(() => this.world.cameraObstacles);
    // Streamed dressing → precompile its shaders before revealing the world, so turning the camera never hitches.
    const loading = new LoadingOverlay(container, this.assetManager);
    this.worldReadyAndWarm = this.world.ready
      .then(() => {
        this.world.revealAllLocations(true);
        return this.renderer.warmUp(this.world.scene, this.camera.camera);
      })
      .finally(() => {
        this.world.revealAllLocations(false);
        loading.finish();
      });
    this.worldHud = new WorldHud(container, this.world.minimap, {
      onOpenProjects: () => this.projectDiscoveryPanel.open(),
      onOpenProject: (projectId) => this.projectDiscoveryPanel.openProject(projectId),
      onOpenCommunity: () => this.communityPanel.open(),
      onOpenWallet: () => this.walletPanel.open(),
      onOpenWatch: () => this.openWatchPanel(),
      // Profile → change character (ADR-015): / name (holders), connect a wallet (guests).
      onChangeCharacter: () => this.openCharacterModal(),
      onChangeName: () => this.openNameModal(this.localNickname, "Change your name"),
      onConnectWallet: () => this.walletPanel.open(),
      // ADR-019 § 1: the moderator key goes in the same field as the hall's host key — from anywhere.
      onModeratorSignIn: () => this.openModeratorSignIn(),
      onOpenModeration: () => this.moderationPanel?.open(),
    });
    const featuredAnchor = this.world.featuredProjectsAnchor;
    if (featuredAnchor) {
      const featured = [...PROJECTS].sort((a, b) => Number(b.featured) - Number(a.featured));
      this.worldHud.setFeaturedProjects(
        featured.map((project) => ({ id: project.id, name: project.name, description: project.shortDescription, hue: project.accentSeed ?? 200 })),
        featuredAnchor,
      );
    }

    this.localPlayer.position.copy(this.world.spawnPoint);
    // Face into the world (the camera starts behind the player looking toward -Z).
    this.localPlayer.object.rotation.y = Math.PI;
    this.world.scene.add(this.localPlayer.object);
    // ADR-015: the local rigged avatar is the player's chosen (or default) model — loaded once it is known
    // (onboarding for a holder, `welcome` for a guest), so you see yourself exactly as everyone else does.
    this.avatarLibrary = new RemoteAvatarLibrary(this.assetManager);

    this.playerController = new PlayerController(
      this.input,
      this.collisions,
      this.localPlayer,
      () => this.camera.currentYaw,
      this.world.groundHeightAt,
    );

    this.nameplates = new NameplateManager(container);
    this.remotePlayers = new RemotePlayerManager({
      scene: this.world.scene,
      nameplates: this.nameplates,
      interactions: this.interactions,
      interactionRadius: SOCIAL_INTERACTION_RADIUS_METERS,
      onPlayerSelected: (playerId) => this.onPlayerSelected(playerId),
      // ADR-014 § 11: KayKit remote avatars on the high tier, the placeholder on low (ADR-008).
      avatars: this.world.usesRiggedAvatars ? this.avatarLibrary : null,
    });
    this.floatingReactions = new FloatingReactions(container);

    this.playerContextCard = new PlayerContextCard(container);
    this.playerContextCard.onBlock((playerId) => {
      this.socialStore.block(playerId);
      this.remotePlayers.setBlocked(playerId, true);
      this.playerContextCard.close();
    });
    this.playerContextCard.onWhisper((playerId, nickname) => this.worldHud.chat.startWhisper(playerId, nickname));
    this.playerContextCard.onVolumeChange((playerId, volume) => this.socialStore.setVolume(playerId, volume));
    this.playerContextCard.onMuteToggle((playerId, muted) => {
      // Local-only: never transmitted to the server or the muted player. See SocialStore.mute()'s docstring.
      if (muted) this.socialStore.mute(playerId);
      else this.socialStore.unmute(playerId);
    });
    // ADR-019 §§ 2–3: Report (everyone) and a moderator's Mute… / Kick / Ban….
    this.playerContextCard.onReport((playerId, nickname) => this.openReport(playerId, nickname));
    this.playerContextCard.onModerate((verb, playerId, nickname) => this.openModeration(verb, { nickname, playerId }));
    this.moderationPanel = new ModerationPanel({
      container,
      store: this.moderationStore,
      moderate: (verb, target) => this.openModeration(verb, target),
      send: (message) => this.sendModAction(message),
    });
    this.removedOverlay = new RemovedOverlay({
      container,
      retry: () => {
        this.serverClosed = null;
        this.network.reconnect();
      },
    });

    this.nicknameControls = new NicknameControls(container);
    // ADR-015: renaming is for wallet holders (the control is disabled for guests; the server drops a guest's request anyway).
    this.nicknameControls.onNicknameSubmit((nickname) => {
      if (this.network.connectionState !== "connected" || !this.localCanReceive) return;
      // ADR-016: with fee-confirmed names a new name goes through the fee step (never a silent payment).
      if (this.nameConfirmation.requiresFee || this.nameConfirmation.unavailable !== null) this.openNameModal(nickname, "Change your name");
      else this.applyName(nickname);
    });
    this.nicknameControls.onConnectWallet(() => this.walletPanel.open());

    this.voiceSession = new VoiceSession(
      {
        camera: this.camera.camera,
        getRemotePlayerObject: (playerId) => this.remotePlayers.getPlayer(playerId)?.object,
        isMuted: (playerId) => this.socialStore.isMuted(playerId),
        isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
        getPlayerVolume: (playerId) => this.socialStore.getVolume(playerId),
        // The stage holder and floor from the server (never participant attributes), the inside-hall flag from the stage system.
        stage: {
          holder: () => this.hallStore.stage.holder,
          floor: () => this.hallStore.floor,
          inside: () => this.stage?.insideHall ?? false,
          localPlayerId: () => this.localPlayerId,
        },
        stageQuality: () => (this.renderer.quality === "low" ? "medium" : "high"),
      },
      {
        onStateChange: (state) => {
          this.voiceControls.setConnectionState(state, this.voiceSession.connectionMode);
          this.stage?.onVoiceChange(state);
        },
        onSpeakingChanged: (playerId, speaking) => {
          if (playerId === this.localPlayerId) return; // No self-voice UI beyond the mic-active label VoiceControls already shows
          this.remotePlayers.setSpeaking(playerId, speaking);
        },
        onStageTrack: (playerId, track) => this.stage?.setStageTrack(playerId, track),
        onLocalScreenShareEnded: () => this.stage?.localShareEnded(),
        onLocalScreenAudioEnded: () => this.stage?.localScreenAudioEnded(),
        // ADR-019 § 6: the server stopped this participant publishing (a stage turn taken by a host, a
        // moderator or the vote, or a lost identity). Voice drops to listening on the same room — the
        // microphone and any share are released, nearby voices and the stage keep playing — and the panel says so; Enable
        // Voice asks for a new talk grant (the server decides whether the player may still talk).
        onPublishRevoked: () => {
          void this.voiceSession.downgradeToListen().then((kept) => {
            this.voiceControls.setConnectionState(kept ? "connected" : "disconnected", kept ? "listen" : "off");
            this.worldHud.chat.system(
              "The server stopped your microphone and screen share (your stage turn was ended, or you can no longer talk here). You can still listen — Enable Voice to talk again, if you're allowed to.",
            );
          });
        },
        onMicrophoneError: (error) => {
          // Voice failure must never break the rest of the app — never
          // surfaced as a crash. The player is told why (permission, no device, an
          // insecure page, the operating system) and what to do; voice stays connected for listening.
          console.warn("[voice] microphone unavailable:", error);
          this.voiceControls.setMicStatus(false, true);
          this.reportVoiceFailure(error, "microphone", "talk");
        },
      },
    );
    this.voiceControls = new VoiceControls(container);
    this.voiceControls.setConnectionState("disconnected");
    this.voiceControls.onEnable(() => this.enableFullVoice());
    // The failure card's button — open the wallet, try the same thing again, or reload.
    this.voiceControls.onErrorAction((action) => {
      if (action === "open-wallet") this.walletPanel.open();
      else if (action === "reload") window.location.reload();
      else if (this.lastVoiceAttempt === "listen") void this.enableWatchMode().catch(() => undefined);
      else this.enableFullVoice();
    });
    // ADR-015: guests may listen, never talk. Without an unlocked wallet the same button listens — nearby voices and the stage, never a microphone.
    this.voiceControls.onListen(() => {
      void this.enableWatchMode()
        .then(() => this.worldHud.chat.system(this.listeningLine()))
        .catch(() => undefined);
    });
    // An unlocked holder on a registry server without a confirmed name listens; the hint
    // ("Confirm a name to talk") opens the name step.
    this.voiceControls.onNameNeeded(() => this.openNameModal(this.localNickname, "Confirm your name"));

    // Voice settings — every change is local or the player's own published range.
    this.voiceControls.onLeave(() => {
      this.voiceSession.disableVoice();
      this.voiceControls.setConnectionState("disconnected");
    });
    this.voiceControls.onRange((range) => {
      this.voiceControls.setRange(range);
      this.voiceSession.setRange(range).catch((error) => console.warn("[voice] range update failed:", error));
    });
    this.voiceControls.onMode((mode) => {
      this.voiceControls.setMode(mode);
      void this.voiceSession.setMicMode(mode).then(() => this.voiceControls.setMicStatus(false, !this.voiceSession.hasMicrophone));
    });
    this.voiceControls.onMicToggle(() => {
      void this.voiceSession.toggleOpenMic().then((live) => this.voiceControls.setMicStatus(live, !this.voiceSession.hasMicrophone));
    });
    this.voiceControls.onVolume((volume) => this.voiceSession.setMasterVolume(volume));
    this.voiceControls.setStageVolume(this.voiceSession.stageVolume);
    this.voiceControls.onStageVolume((volume) => {
      this.voiceSession.setStageVolume(volume);
      this.stageWidget.setStageVolume(volume); // the stage widget has the same slider
    });
    this.voiceControls.onWalletNeeded(() => this.walletPanel.open());
    this.voiceControls.onDevice(
      (deviceId) => void this.voiceSession.switchMicrophone(deviceId).catch((error) => console.warn("[voice] microphone switch failed:", error)),
      () => this.voiceSession.listMicrophones(),
    );

    // Bind voice session to wallet participation lifecycle
    this.unsubscribeVoiceParticipation = bindVoiceParticipation({
      subscribeToCapabilities,
      voiceSession: this.voiceSession,
      voiceControls: this.voiceControls,
    });

    // The Watch Hall stage — the server-arbitrated big screen with tab audio, the holder's share flow and
    // watch mode (ADR-014).
    this.stage = new StageSystem({
      container,
      screen: this.world.watchHall?.screen ?? null,
      hall: this.hallStore,
      voice: this.voiceSession,
      send: (message) => this.network.sendHall(message),
      register: (interactable) => this.interactions.register(interactable),
      unregister: (id) => this.interactions.unregister(id),
      nicknameOf: (playerId) => this.remotePlayers.getPlayer(playerId)?.nickname,
      isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
      announce: (text) => this.worldHud.chat.system(text),
      enableListening: () => this.enableWatchMode(),
      requestVoice: () => this.requestTalk(),
      canTalk: () => getParticipationCapabilities().canVoice,
      isHolder: () => isWalletHolder(),
      // With a name registry the server lets only confirmed names present, take the floor, vote and talk.
      identity: () => ({ namesRequired: this.nameConfirmation.requiresFee, hasName: !this.needsConfirmedName() }),
      requestName: () => this.openNameModal(this.localNickname, "Confirm your name"),
      // ADR-014 § 4 (the computer-sound option): system audio would capture the personal YouTube player.
      beforeComputerSound: () => {
        if (!this.personalPlayer.isOpen) return;
        this.personalPlayer.close();
        this.worldHud.chat.system("Closed your YouTube player first, so its sound isn't shared with the hall.");
      },
    });
    // Where the Watch panel, the personal player and the stage meet.
    // The personal YouTube player ducks the stage audio while it is open.
    this.personalPlayer.onOpenChange((open) => this.voiceSession.duck(open));
    // The player stays closed while a computer-sound share is live (system audio would capture it): a consent
    // accepted mid-share, or any other path that opened it, is closed again.
    this.stage.subscribe((state) => {
      if (!state.sharingSystemAudio || !(this.personalPlayer.isOpen || this.personalPlayer.isConsentOpen)) return;
      this.personalPlayer.close();
      this.worldHud.chat.system("Closed your YouTube player — your computer's sound is shared with the hall.");
    });
    // The holder's "Show on the big screen" sets the stage card from the catalogue (re-validated by the stage system and the server).
    this.watchPanel.onShowOnStage((request) => {
      if (!this.stage.setCard({ ...request })) this.worldHud.chat.system("That video could not be set as the stage card.");
    });
    // The Watch panel's in-hall stage entry and its "Show on the big screen" buttons follow the stage state.
    this.stage.subscribe(() => this.refreshWatchStage());

    // The hall's social UI. Every action goes through the stage system or the
    // hall store; the server decides, and refusals come back as hall_error → short chat lines.
    this.stageWidget = new StageWidget({
      container,
      stage: this.stage,
      hall: this.hallStore,
      nicknameOf: (playerId) => this.remotePlayers.getPlayer(playerId)?.nickname,
      voice: this.voiceSession,
      canTalk: () => getParticipationCapabilities().canVoice,
      isHolder: () => isWalletHolder(),
      requestVoice: () => this.requestTalk(),
      requestName: () => this.openNameModal(this.localNickname, "Confirm your name"),
      sendHostKey: (key) => this.network.sendHall({ type: "hall_host_auth", key }),
      openCatalogue: () => this.openWatchPanel("replays"),
      announce: (text) => this.worldHud.chat.system(text),
    });
    this.stageWidget.setStageVolume(this.voiceSession.stageVolume);
    this.stageWidget.onStageVolume((volume) => {
      this.voiceSession.setStageVolume(volume);
      this.voiceControls.setStageVolume(volume);
    });
    this.discussionMenu = new DiscussionMenu(container, {
      onLiveChat: () => {
        if (!this.openHallReactions) {
          this.worldHud.chat.showHall();
          return;
        }
        if (this.worldHud.chat.showHall({ focus: false })) this.openHallReactions();
      },
      onShareTakeaway: () => void this.worldHud.chat.showHall({ prefill: "💡 " }),
      onStartDiscussion: () => {
        const links = this.hallStore.member ? (this.hallStore.stage.card?.links ?? []) : [];
        const forum = links.find((link) => link.kind === "forum" || new URL(link.url).hostname === "forum.zcashcommunity.com");
        if (!forum || !this.communityPanel.openLink(forum.url)) this.communityPanel.open("forum");
      },
      people: () => this.hallPeople(),
      onOpenPlayer: (playerId) => this.onPlayerSelected(playerId),
    });
    this.speakerCard = new SpeakerCardPanel(
      container,
      {
        openInGame: (href) => this.communityPanel.openLink(href),
        watchHere: (video) => this.watchHere(video),
      },
      this.stageWidget.chipSlot, // the "Now on stage" chip stacks above the stage widget, under the minimap
    );
    this.hallBoards = new HallBoards({
      boards: this.world.watchHall,
      hall: this.hallStore,
      watch: this.watchClient,
      setUpNext: (text) => this.stage.setUpNext(text),
      nameOf: (playerId) => this.hallName(playerId),
      isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
      members: () => hallMemberCount(this.remotePlayers.getPositions(), this.hallStore.member),
      thumb: (src) => proxiedImage(src),
    });
    this.stage.subscribe(() => this.refreshSpeakerCard());
    this.world.onLocationChange(() => this.refreshSpeakerCard());
    this.hallStore.subscribe((event) => {
      if (event.type === "error" && event.op === "host" && this.moderatorKeyDialog) {
        this.moderatorKeyDialog.fail(moderatorSignInError(event.reason));
        return;
      }
      if (event.type !== "change") return;
      // The Hall chat tab exists only while the server counts this session as a member.
      if (event.parts.includes("member")) this.worldHud.chat.setHallVisible(this.hallStore.member);
      this.discussionMenu.refresh();
    });
    // The moderator role, the new-report count, the menu's moderator section and this session's mute.
    this.moderationStore.subscribe((event) => {
      const store = this.moderationStore;
      if (event.type === "report") {
        const report = event.report;
        this.worldHud.chat.system(`🛡 New report: ${report.reporter} reported ${report.target} (${REPORT_REASON_LABELS[report.reason]}, ${LOCATION_LABELS[report.location]}) — open Moderation on the action bar.`);
        return;
      }
      this.worldHud.setModerator(store.isModerator, store.unseenReports);
      this.playerContextCard.setModeratorTools(store.isModerator);
      this.worldHud.chat.setMuted(store.mutedUntil);
      if (store.isModerator && !this.wasModerator) {
        this.moderatorKeyDialog?.close();
        this.worldHud.chat.system("🛡 You're signed in as a moderator for this session: Mute / Kick / Ban in any player's menu, reports and the log under Moderation on the action bar, and every Watch Hall host tool. Your nameplate shows a Moderator tag.");
      }
      this.wasModerator = store.isModerator;
    });

    // ADR-014 §§ 9–11: seats, hall presence on avatars/nameplates, emotes and reactions.
    this.seats = new SeatSystem({
      seats: this.world.watchHall?.seats ?? [],
      hall: this.hallStore,
      controller: this.playerController,
      playerPosition: this.localPlayer.position,
      send: (message) => this.network.sendHall(message),
      register: (interactable) => this.interactions.register(interactable),
      unregister: (id) => this.interactions.unregister(id),
      camera: this.camera,
      announce: (text) => this.worldHud.chat.system(text),
      onSeatedChange: () => this.refreshTitleCard(),
    });
    this.hallPresence = new HallPresence({
      hall: this.hallStore,
      seats: this.world.watchHall?.seats ?? [],
      players: this.remotePlayers,
      localAnimation: this.localPlayer.animation,
      localPosition: this.localPlayer.position,
      reactions: this.floatingReactions,
      isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
      localSeated: () => this.seats.seatedOn !== null,
    });
    this.emotes = new EmoteController({
      container,
      inHall: () => this.hallStore.member,
      handRaised: () => this.hallStore.myHandRaised,
      send: (message) => this.network.sendHall(message),
      playEmote: (emote) => this.playerController.playEmote(emote),
      showOwnReaction: (reaction) => this.floatingReactions.spawn(LOCAL_BUBBLE_ID, reaction),
      announce: (text) => this.worldHud.chat.system(text),
    });
    // Discussion Corner → Live Chat & Reactions: the Hall tab plus the emote wheel's reactions sub-wheel.
    this.openHallReactions = () => this.emotes.openReactions();

    // ADR-013: private player-to-player ZEC — the server relays sealed handshakes only.
    this.paymentFlow = new PaymentFlow(container, {
      send: (message) => this.network.sendPayment(message),
      openWallet: () => this.walletPanel.open(),
      isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
      announce: (text) => this.worldHud.chat.system(text),
      // ADR-018: the transfer fee this server advertised — a relayed quote must match it.
      advertisedFeeZat: () => this.paymentInfo?.feeZat ?? null,
      // The operator's approximate fiat label for that fee ("≈ US$1"), or none.
      feeUsd: () => this.paymentInfo?.feeUsd ?? null,
    });
    // ADR-018: a newer client build reloads only between actions (never during a send or an onboarding/wallet step),
    // nor while this player presents on the Watch Hall stage — a reload would end the share for the hall.
    this.updatePrompt = new UpdatePrompt(container, {
      clientBuild: (import.meta.env.VITE_BUILD_ID as string | undefined) ?? null,
      isBusy: () =>
        this.paymentFlow.busy ||
        this.walletPanel.isBusy ||
        this.onboarding?.isOpen === true ||
        getWalletState().txidInProgress !== null ||
        // A reload mid-migration would restart the one-time rescan of a Stage-1 wallet from the start.
        getWalletState().migration !== null ||
        this.feeNames?.busy === true ||
        this.stage?.state.sharing === true,
    });
    window.setInterval(() => void this.checkServerBuild(), 10 * 60_000);
    this.playerContextCard.setSendZec((playerId, nickname) => void this.paymentFlow.start(playerId, nickname));

    const hallFeed = hallStoreFeed(this.hallStore);
    this.network = new NetworkClient(getWebSocketUrl(), {
      onPayment: (message) => this.paymentFlow.handle(message),
      onHall: hallFeed.onHall,
      onModeration: (message) => this.onModerationMessage(message),
      onClosedByServer: (reason, notice) => {
        // Kicked, banned or refused — a clear notice instead of "reconnecting…", and no automatic retry.
        this.serverClosed = reason;
        const until = notice?.until ?? null;
        const text = removedText(reason, until);
        this.worldHud.chat.system(`${text.title}. ${text.detail}`);
        this.removedOverlay.show(reason, until);
      },
      onStateChange: (state) => {
        hallFeed.onStateChange(state);
        this.connectionStatus?.setState(state);
        this.worldHud.chat.setConnected(state === "connected");
        if (state === "disconnected") {
          // Drop any remote players we knew about — a reconnect gets a
          // fresh player_snapshot, we never want a stale roster lingering.
          this.remotePlayers.clear();
          // The server invalidates this session's voice capability the
          // instant the WebSocket closes (WorldServer.handleClose) — a
          // reconnect gets a brand-new one via the next welcome, never
          // this stale value. Clearing it here is a client-side mirror
          // of that fact, not what enforces it.
          this.voiceCapability = null;
          // Voice identity is the old session's playerId — leave the voice room too; the player
          // re-enables voice after reconnecting (never silently re-opening the microphone).
          if (this.voiceSession.connectionState !== "disconnected") {
            this.voiceSession.disableVoice();
            this.voiceControls.setConnectionState("disconnected");
          }
          // The moderator role is per session (sign in again after a reconnect); tags and mutes come back.
          this.moderationStore.reset();
          this.moderationPanel.close();
          this.reportDialog?.close();
          this.moderationDialog?.close();
          this.moderatorKeyDialog?.close();
          if (this.serverClosed === null) this.worldHud.chat.system("Connection lost — reconnecting…");
        }
        if (state === "connected") this.worldHud.chat.system("Connected.");
        // ADR-016: the server's name mode is fetched at startup; a server that was down then is asked again.
        if (state === "connected" && !this.nameModeKnown) this.nameModeReady = this.loadNameMode();
        // A name being confirmed across a reconnect: re-bind its reservation to the new session (never pays twice).
        if (state === "connected") this.feeNames?.resume();
        this.updatePlayerCountLabel();
      },
      onWelcome: (message) => {
        hallFeed.onWelcome(message);
        this.updatePrompt.announce(message.build);
        this.moderationStore.setLocalPlayerId(message.playerId);
        this.removedOverlay.hide();
        this.localPlayerId = message.playerId;
        this.localNickname = message.nickname;
        this.nicknameControls.setCurrentNickname(message.nickname);
        this.worldHud.setNickname(message.nickname);
        this.refreshVoiceNameGate();
        // A (re)connect always gets a fresh
        // capability (see WorldServer.handleJoin) — stale on disconnect,
        // see onStateChange's "disconnected" branch above.
        this.voiceCapability = message.voiceCapability;
        // ADR-015: the server-accepted look and wallet-holder flag.
        this.setLocalCanReceive(message.canReceive);
        this.applyLocalAvatar(message.avatar);
        // The holder flag changed while the join was on its way: tell the server now.
        if (message.canReceive !== isWalletHolder()) this.network.sendWallet(isWalletHolder());
        if (this.pendingName !== null) {
          const name = this.pendingName;
          this.pendingName = null;
          // ADR-016: a name confirmed or claimed during onboarding already arrives with the welcome.
          if (isWalletHolder() && nicknameKey(message.nickname) !== nicknameKey(name)) this.applyName(name);
        } else if (this.nameConfirmation.requiresFee && message.canReceive && isWalletHolder() && GUEST_NICKNAME_PATTERN.test(message.nickname)) {
          // ADR-016: a reconnect is a new session — the owned name comes back by proving the key again (no fee).
          const remembered = this.profile?.lastMode === "holder" ? this.profile.nickname : undefined;
          if (remembered) this.applyName(remembered);
        } else if (!message.canReceive && !this.welcomedOnce) {
          this.worldHud.chat.system(`You're ${message.nickname} — a guest. Connect a wallet (Profile) to choose a name and character, talk and use ZEC.`);
        }
        this.welcomedOnce = true;
      },
      onAvatarUpdated: (message) => {
        if (message.playerId === this.localPlayerId) {
          this.applyLocalAvatar(message.avatar);
          // Remember a holder's own choice — not the default look "Forget this wallet" brings back.
          if (this.localCanReceive && isWalletHolder()) this.rememberProfile({ mode: "holder", avatar: message.avatar });
        } else {
          this.remotePlayers.updateAvatar(message.playerId, message.avatar);
        }
      },
      onCanReceiveUpdated: (message) => {
        if (message.playerId === this.localPlayerId) {
          this.setLocalCanReceive(message.canReceive);
          return;
        }
        this.remotePlayers.updateCanReceive(message.playerId, message.canReceive);
        // The player menu follows live (Send ZEC enabled/disabled, the "Can receive ZEC privately" row).
        this.playerContextCard.setCanReceive(message.playerId, message.canReceive);
      },
      onNicknameCheckResult: (message) => this.onboarding.handleNicknameCheckResult(message),
      // ADR-016: owner-only name answers (quote, status, claim challenge) feed the fee flow.
      onName: (message) => this.feeNames?.handle(message),
      onSnapshot: (message) => {
        for (const player of message.players) {
          this.remotePlayers.spawn(player);
          if (player.moderator) this.moderationStore.setTagged(player.playerId, true);
        }
        this.updatePlayerCountLabel();
      },
      onPlayerJoined: (message) => {
        this.remotePlayers.spawn(message);
        if (message.moderator) this.moderationStore.setTagged(message.playerId, true);
        this.updatePlayerCountLabel();
      },
      onPlayerLeft: (message) => {
        this.remotePlayers.despawn(message.playerId);
        this.moderationStore.forget(message.playerId);
        this.updatePlayerCountLabel();
      },
      onPlayerTransform: (message) => this.remotePlayers.receiveTransform(message),
      onChatMessage: (message) => {
        const own = message.fromPlayerId === this.localPlayerId;
        // Block is local-only: a blocked player's lines are simply not shown.
        if (!own && this.socialStore.isBlocked(message.fromPlayerId)) return;
        this.worldHud.chat.add({ ...message, own });
        // Hall lines also feed the Discussion Corner board (in memory only, dropped on leaving the hall).
        if (message.channel === "hall") this.hallBoards.addChatLine({ playerId: message.fromPlayerId, nickname: message.fromNickname, text: message.text });
        // Whispers are private and hall lines belong to the Hall tab / Discussion Corner: no bubbles.
        if (message.channel === "whisper" || message.channel === "hall") return;
        if (own) this.nameplates.say(LOCAL_BUBBLE_ID, message.text);
        else this.remotePlayers.say(message.fromPlayerId, message.text);
      },
      onChatRejected: (message) => this.worldHud.chat.rejected(message.reason),
      onNicknameUpdated: (message) => {
        if (message.playerId === this.localPlayerId) {
          this.localNickname = message.nickname;
          this.nicknameControls.setCurrentNickname(message.nickname);
          this.worldHud.setNickname(message.nickname);
          this.refreshVoiceNameGate();
          this.onOwnNameChanged(message.nickname);
        } else {
          this.remotePlayers.updateNickname(message.playerId, message.nickname);
        }
      },
    });
    // ADR-015: the socket opens now (onboarding can ask nickname_check), but the player joins only when
    // onboarding finishes — until then nobody sees them.
    this.network.connect();
    // ADR-015's honour system until the server says otherwise (ADR-016: fee-confirmed names, or disabled).
    this.nameConfirmation = new NameConfirmationSwitch(immediateNameConfirmation((nickname) => this.network.sendNickname(nickname)));
    this.nameModeReady = this.loadNameMode();
    this.profile = loadProfile();
    this.onboarding = new OnboardingFlow({
      container,
      profile: this.profile,
      wallet: {
        status: () => ZcashWalletAdapter.state.status,
        subscribe: (listener) => subscribeToWalletState((state) => listener(state.status)),
        isHolder: () => isWalletHolder(),
        subscribeHolder: (listener) => subscribeToWalletHolder(listener),
        open: (onReady) => this.walletPanel.openForOnboarding(onReady),
        close: () => {
          if (this.walletPanel.isOpen) this.walletPanel.close();
        },
        isBusy: () => this.walletPanel.isBusy,
        unlock: (passphrase) => ZcashWalletAdapter.unlock(passphrase),
      },
      checkNickname: (nickname) => this.network.checkNickname(nickname),
      worldReady: this.worldReadyAndWarm,
      createPreview: () => createCharacterPreview({ avatars: this.avatarLibrary }),
      nameConfirmation: this.nameConfirmation,
      onComplete: (result) => this.enterWorld(result),
      network: ZCASH_NETWORK,
    });
    // ADR-015: the sticky wallet-holder flag is the one wallet-derived bit that leaves the browser (join.wallet / set_wallet).
    this.unsubscribeWalletHolder = subscribeToWalletHolder((holder) => this.onWalletHolderChange(holder));
    // End-to-end tests (DEV / VITE_TEST_HOOKS builds only): a seeded `autoEnter: "guest"` profile skips onboarding, so
    // the existing specs keep working with a plain goto("/"). A production build ignores it.
    // A `?perf=…` scene (same builds only) enters as a guest too, so the numbers never include the onboarding overlay.
    if ((this.profile?.autoEnter === "guest" || perfKind !== null) && testHooks) {
      this.network.join({ wallet: isWalletHolder() });
    } else {
      this.onboarding.start();
    }

    // Text chat — the panel decides the target, the server relays (never stores) the line.
    this.worldHud.chat.setNicknameResolver((nickname) => this.remotePlayers.findByNickname(nickname));
    this.worldHud.chat.onSend((target, text) => {
      if (target.kind === "whisper") this.network.sendWhisper(target.playerId, text);
      else this.network.sendChat(target.channel, text);
    });

    this.debugStats = import.meta.env.DEV ? new DebugStats(container) : null;
    this.connectionStatus = import.meta.env.DEV ? new ConnectionStatus(container) : null;
    if (import.meta.env.DEV || import.meta.env.VITE_TEST_HOOKS === "1") {
      // Convenience hooks for debugging (and for end-to-end tests of a production build: VITE_TEST_HOOKS=1), to poke character and asset
      // state from devtools without wiring a temporary UI button.
      (window as unknown as { __assetManager: AssetManager }).__assetManager = this.assetManager;
      (window as unknown as { __localPlayer: LocalPlayer }).__localPlayer = this.localPlayer;
      (window as unknown as { __networkClient: NetworkClient }).__networkClient = this.network;
      (window as unknown as { __remotePlayers: RemotePlayerManager }).__remotePlayers = this.remotePlayers;
      (window as unknown as { __socialStore: SocialStore }).__socialStore = this.socialStore;
      (window as unknown as { __voiceSession: VoiceSession }).__voiceSession = this.voiceSession;
      (window as unknown as { __paymentFlow: PaymentFlow }).__paymentFlow = this.paymentFlow;
      (window as unknown as { __hallStore: HallStore }).__hallStore = this.hallStore;
      // The moderator role, reports, log and bans/mutes as the server sent them (e2e: moderation.spec).
      (window as unknown as { __moderationStore: ModerationStore }).__moderationStore = this.moderationStore;
      (window as unknown as { __stageSystem: StageSystem }).__stageSystem = this.stage;
      (window as unknown as { __seatSystem: SeatSystem }).__seatSystem = this.seats;
      (window as unknown as { __emotes: EmoteController }).__emotes = this.emotes;
      (window as unknown as { __floatingReactions: FloatingReactions }).__floatingReactions = this.floatingReactions;
      (window as unknown as { __wallet: { adapter: typeof ZcashWalletAdapter; state: typeof getWalletState } }).__wallet = { adapter: ZcashWalletAdapter, state: getWalletState };
      // The e2e suite's stubbed wallet engine (a fake ZecWallet factory) and the adapter's cap policy.
      (window as unknown as { __walletEngineTestSeam: typeof walletEngineTestSeam }).__walletEngineTestSeam = walletEngineTestSeam;
      (window as unknown as { __walletPolicyTestSeam: typeof __walletPolicyTestSeam }).__walletPolicyTestSeam = __walletPolicyTestSeam;
      (window as unknown as { __updatePrompt: UpdatePrompt }).__updatePrompt = this.updatePrompt;
      // Lets tests/e2e/projects.spec.ts call
      // showDetailForTesting() with hostile content through the real render path.
      (window as unknown as { __projectDiscoveryPanel: ProjectDiscoveryPanel }).__projectDiscoveryPanel = this.projectDiscoveryPanel;
      // World-building screenshots: free camera for overview screenshots + a "dressing loaded" flag.
      (window as unknown as { __setPhotoCamera: (pose: PhotoPose | null) => void }).__setPhotoCamera = (pose) => this.setPhotoCamera(pose);
      (window as unknown as { __worldScene: THREE.Scene }).__worldScene = this.world.scene;
      (window as unknown as { __learningProgress: LearningProgress }).__learningProgress = this.learningProgress;
      // Opens lessons of the active catalogue directly (e2e checks of the Learning panel without lesson stations).
      (window as unknown as { __learningPanel: LearningPanel }).__learningPanel = this.learningPanel;
      // Walkability checks in end-to-end tests: probe the colliders and list the interactables.
      (window as unknown as { __collisions: CollisionSystem }).__collisions = this.collisions;
      (window as unknown as { __interactions: InteractionSystem }).__interactions = this.interactions;
      // The hall's screen/board handles, for demo content in screenshots and for e2e checks.
      (window as unknown as { __watchHall: WatchHallHandles | null }).__watchHall = this.world.watchHall;
      // Named positions of the active content (the project board, the hall door, the podium, ...) for end-to-end tests.
      // Whether players appear as rigged models in this session (content and render tier allowing).
      (window as unknown as { __riggedAvatars: boolean }).__riggedAvatars = this.world.usesRiggedAvatars;
      (window as unknown as { __anchors: AnchorMap }).__anchors = mergeAnchors(this.world.anchors, this.content.hallLayout ? hallAnchors(this.content.hallLayout) : {});
      // What the hall boards were last fed (e2e: hall chat, takeaways, reaction tallies, member count, Live Now rows).
      (window as unknown as { __hallBoards: { snapshot(): HallBoardsSnapshot } }).__hallBoards = this.hallBoards;
      // The onboarding flow and this session's server-confirmed identity (e2e: identity.spec, onboarding.spec).
      (window as unknown as { __onboarding: OnboardingFlow }).__onboarding = this.onboarding;
      // ADR-016: confirm a name through whatever this server runs (honour: set_nickname; dev registry: reserve →
      // auto-confirm, nothing paid). E2E specs activate a test name key first (zcash/nameKey.ts).
      (window as unknown as { __confirmName: (nickname: string) => Promise<void> }).__confirmName = async (nickname) => {
        await this.nameModeReady;
        await this.nameConfirmation.confirm(nickname);
      };
      (window as unknown as { __identity: () => { canReceive: boolean; avatar: PlayerAvatar | null; nickname: string } }).__identity = () => ({
        canReceive: this.localCanReceive,
        avatar: this.localAvatar ? { ...this.localAvatar } : null,
        nickname: this.localNickname,
      });
      this.worldReadyAndWarm.then(() => {
        (window as unknown as { __worldReady: boolean }).__worldReady = true;
      });
      if (perfKind) this.installPerfScene(perfKind);
    }

    this.gameLoop = new GameLoop(
      (delta) => this.update(delta),
      () => this.render(),
    );

    window.addEventListener("resize", this.onResize);
  }

  start(): void {
    this.gameLoop.start();
  }

  private update(frameDelta: number): void {
    this.perf?.begin();
    // `?perf=…&perfdt=60` (DEV / test hooks): every frame advances 1/60 s, so a slow software renderer does the CPU work
    // per frame that a 60 FPS machine does (time-based animation rates, timers) — for CPU-side measurements only.
    const delta = this.perfFixedDelta > 0 ? this.perfFixedDelta : frameDelta;
    this.debugStats?.beginFrame();
    this.renderer.adapt(delta);

    // While the start-of-game flow is open the player hasn't joined — no moving, emotes or interactions behind it.
    const onboarding = this.onboarding.isOnboarding;
    // Before the camera: an open emote wheel takes the pointer-lock mouse movement as its pick direction.
    if (!onboarding) this.emotes.update(this.input);
    // Seated in the Watch Hall: a raised camera target, so the view clears every head and frames the whole screen.
    this.camera.update(delta, this.input, this.localPlayer.position, this.seats.seatedOn !== null ? SEATED_TARGET_HEIGHT : this.localPlayer.height);
    if (!onboarding) {
      this.playerController.update(delta);
      this.interactions.update(this.localPlayer.position, this.input);
    }
    this.world.update(delta, this.photoCamera ?? this.camera.camera);
    if (this.world.minimap !== this.shownMap) {
      this.shownMap = this.world.minimap;
      this.worldHud.setMapData(this.shownMap);
    }
    this.worldHud.update(delta, this.localPlayer.position.x, this.localPlayer.position.z, this.localPlayer.object.rotation.y, this.camera.currentYaw);
    this.perf?.mark("world");
    this.perfScene?.update(delta);
    // ADR-010: remote players outside the active location are hidden and not animated; off-screen ones defer their animation.
    const activeLocation = this.world.activeLocation;
    // The frame-pacing guard's crowd lever (still slow at the lowest resolution: less crowd animation).
    this.remotePlayers.setReducedDetail(this.renderer.crowdReduced);
    this.remotePlayers.update(delta, { camera: this.photoCamera ?? this.camera.camera, inActiveLocation: (x) => locationAt(x) === activeLocation });
    this.hallPresence.update();
    this.perf?.mark("players");
    this.publishLocalTransform(delta);
    this.updateNearbyPlayers();
    this.updateVoice();
    this.updateHallUi(delta);

    // ADR-015: Esc never closes onboarding (nor anything under it); a mid-session onboarding modal handles its own Esc.
    if (this.input.wasJustPressed("menu") && !this.onboarding.isOpen) {
      if (this.projectDiscoveryPanel.isOpen) this.projectDiscoveryPanel.close();
      if (this.playerContextCard.isOpen) this.playerContextCard.close();
      if (this.worldHud.isShellOpen) this.worldHud.closeShell();
      if (this.communityPanel.isOpen) this.communityPanel.close();
      if (this.walletPanel.isOpen) this.walletPanel.close();
      if (this.stage.isViewerOpen) this.stage.closeViewer();
      if (this.stage.isDialogOpen) this.stage.closeDialog();
      if (this.portalPanel.isOpen) this.portalPanel.close();
      if (this.learningPanel.isOpen) this.learningPanel.close();
      if (this.personalPlayer.isOpen || this.personalPlayer.isConsentOpen) this.personalPlayer.close();
      if (this.watchPanel.isOpen) this.watchPanel.close();
      if (this.discussionMenu.isOpen) this.discussionMenu.close();
      if (this.speakerCard.isOpen) this.speakerCard.close();
      if (this.stageWidget.isDialogOpen) this.stageWidget.closeDialogs();
      if (this.moderationPanel.isOpen) this.moderationPanel.close();
    }

    this.input.endFrame();
    this.perf?.mark("rest");
  }

  /** Push-to-talk polling (held V → transmit) + per-frame distance-gain recompute for every subscribed remote voice track. A no-op before `enableVoice()` has ever succeeded — see VoiceClient.setTransmitting()/VoiceSession.update(). */
  private updateVoice(): void {
    const pushToTalkPressed = this.input.isPressed("pushToTalk");
    if (pushToTalkPressed !== this.pushToTalkWasPressed) {
      this.pushToTalkWasPressed = pushToTalkPressed;
      // ADR-015: someone listening without a wallet to talk with presses V — say why nothing is sent (at most every 10 s).
      if (pushToTalkPressed && this.voiceSession.connectionMode === "listen" && !getParticipationCapabilities().canVoice && performance.now() - this.guestTalkHintAt > 10_000) {
        this.guestTalkHintAt = performance.now();
        this.worldHud.chat.system(this.localCanReceive ? "Unlock your wallet to talk — you're listening only." : "Connect a wallet to talk — guests can listen and write in chat.");
      }
      this.voiceSession.setPushToTalk(pushToTalkPressed).catch((error) => {
        console.warn("[voice] failed to toggle transmit state:", error);
      });
      if (this.voiceSession.mode === "push-to-talk") {
        // "No microphone" only means something once voice is connected; before that the label
        // just mirrors the key (the input-isolation tests read it).
        const noMicrophone = this.voiceSession.connectionState === "connected" && !this.voiceSession.hasMicrophone;
        this.voiceControls.setMicStatus(pushToTalkPressed && !noMicrophone, noMicrophone);
      }
    }
    this.stage.update(this.localPlayer.position);
    this.voiceSession.update(this.localPlayer.position);
  }

  /** Opens the Watch panel with a fresh stage entry. */
  private openWatchPanel(tab?: WatchTab): void {
    this.refreshWatchStage();
    this.watchPanel.open(tab);
  }

  /**
   * Per frame: the board feeds (≤ 1 Hz, only while the hall is the active location), the stage widget's
   * countdown, and about once a second the Discussion menu's people list (speaking state changes without a hall event).
   */
  private updateHallUi(delta: number): void {
    this.hallBoards.update(this.world.activeLocation === "hall");
    this.stageWidget.update();
    // On stage or with the floor, inside the hall, this player's microphone is heard hall-wide: VoiceControls says so.
    const local = this.localPlayerId;
    const hall = this.hallStore;
    this.voiceControls.setHallWide(
      this.voiceSession.connectionMode === "full" && hall.member && local !== null && this.stage.insideHall && (hall.stage.holder === local || hall.floor === local),
    );
    this.discussionRefreshTimer += delta;
    if (this.discussionRefreshTimer >= 1) {
      this.discussionRefreshTimer = 0;
      this.discussionMenu.refresh();
    }
  }

  /** A hall player's nickname from presence ("You" for the local player); hall state carries playerIds only. */
  private hallName(playerId: string): string {
    if (playerId === this.localPlayerId) return "You";
    return this.remotePlayers.getPlayer(playerId)?.nickname ?? "Someone";
  }

  /** "Find Your People": hall members as this client sees them (positions inside the hall, or named by hall state). */
  private hallPeople(): HallPerson[] {
    const hall = this.hallStore;
    const remote = this.remotePlayers.getPositions().map((player) => ({ playerId: player.playerId, nickname: this.remotePlayers.getPlayer(player.playerId)?.nickname ?? "Someone", x: player.x, z: player.z }));
    return buildHallPeople({
      localPlayerId: this.localPlayerId,
      localNickname: this.localNickname,
      member: hall.member,
      remote,
      hallSeats: this.world.watchHall?.seats ?? [],
      seats: hall.seats,
      hands: hall.hands,
      holder: hall.stage.holder,
      floor: hall.floor,
      hosts: hall.hosts,
      isSpeaking: (playerId) => this.voiceSession.isSpeaking(playerId),
      isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
    });
  }

  /** The speaker card dialog and its HUD "Now on stage" chip (shown while the hall is active and the stage has a card). */
  private refreshSpeakerCard(): void {
    const hall = this.hallStore;
    const stage = hall.stage;
    const holder = hall.member ? stage.holder : null;
    const card = hall.member ? stage.card : null;
    const view: SpeakerCardView | null =
      holder !== null || card !== null
        ? { mode: holder === null ? "next" : stage.status === "live" ? "live" : "preparing", card, presenter: holder === null ? null : this.hallName(holder), audio: stage.audio }
        : null;
    const inHall = hall.member && this.world.activeLocation === "hall";
    const key = JSON.stringify([view, inHall]);
    if (key === this.speakerCardKey) return;
    this.speakerCardKey = key;
    this.speakerCard.setView(view, inHall);
  }

  /**
   * The top-left card in the hall names the place and, in plain words, the keys that matter there
   * — seated, how to stand up.
   */
  private refreshTitleCard(): void {
    if (this.world.activeLocation !== "hall") {
      this.hud.setTitleCard(null);
      return;
    }
    const seated = this.seats?.seatedOn !== null && this.seats?.seatedOn !== undefined;
    this.hud.setTitleCard({
      title: "WATCH HALL — Zocial World",
      subtitle: seated ? "Seated · WASD: stand up · Hold G: emotes · H: raise hand · 1–8: react" : "WASD: move · E: sit / use · Hold G: emotes · H: raise hand · 1–8: react",
    });
  }

  /**
   * "Watch here" from the Watch panel or the speaker card. While this player shares their computer's
   * sound, the personal player stays closed: system audio would capture it and the whole hall would hear it.
   */
  private watchHere(video: { id: string; title: string }): void {
    if (this.stage.state.sharingSystemAudio) {
      this.worldHud.chat.system("Stop sharing your computer's sound first — the hall would hear the YouTube player.");
      return;
    }
    this.personalPlayer.play(video);
  }

  /** From a click: full voice when the wallet allows talking, else the wallet panel. */
  private requestTalk(): void {
    if (getParticipationCapabilities().canVoice) this.enableFullVoice();
    else this.walletPanel.open();
  }

  /**
   * The Watch panel's stage entry ("LIVE in the Hall — <nickname> is presenting · 👥 N") and whether the
   * local player may "Show on the big screen". Hall state reaches members only, so players outside the hall see no
   * stage entry. The viewer count is the players this client sees inside the hall (positions are client-reported, ADR-005).
   */
  private refreshWatchStage(): void {
    const hall = this.hallStore;
    this.watchPanel.setCanPresent(hall.member && hall.amHolder);
    const holder = hall.member ? hall.stage.holder : null;
    let info: WatchStageInfo | null = null;
    if (holder) {
      const nickname = holder === this.localPlayerId ? this.localNickname || "You" : (this.remotePlayers.getPlayer(holder)?.nickname ?? "Someone");
      const others = this.remotePlayers.getPositions().filter((player) => hallContains(player.x, player.z, WATCH_HALL_EXIT_MARGIN_METERS)).length;
      const title = hall.stage.card?.title;
      info = { nickname, viewers: others + 1, live: hall.stage.status === "live", inHall: true, ...(title ? { title } : {}) };
    }
    const key = info ? JSON.stringify(info) : "";
    if (key === this.watchStageKey) return;
    this.watchStageKey = key;
    this.watchPanel.setStageInfo(info);
  }

  /**
   * The server runs a name registry and this wallet holder still shows a Guest-style name — with a registry
   * the only way to a chosen name is an owned one, so this is exactly "no owned name". The server then refuses the full
   * voice grant (403 name_required), the stage and the floor; the UI says so before asking.
   */
  private needsConfirmedName(): boolean {
    return this.nameConfirmation.requiresFee && GUEST_NICKNAME_PATTERN.test(this.localNickname);
  }

  /** The voice panel follows the name gate: without a confirmed name its button listens and its hint offers the name step. */
  private refreshVoiceNameGate(): void {
    this.voiceControls.setNameRequired(isWalletHolder() && this.needsConfirmedName());
  }

  /** The chat line after "Listen to voices": what the player can do next to talk. */
  private listeningLine(): string {
    const heard = "Listening: you hear nearby voices and the Watch Hall stage.";
    if (!isWalletHolder() && !this.localCanReceive) return `${heard} Guests can't talk — connect a wallet to use your microphone.`;
    if (!getParticipationCapabilities().canVoice) return `${heard} Unlock your wallet to talk.`;
    if (this.needsConfirmedName()) return `${heard} Talking on this server needs a confirmed name — Confirm a name to talk (${nameFeeWords()}).`;
    return heard;
  }

  /** "Enable Voice" (and the share dialog's button): full, wallet-gated voice — or the upgrade from watch mode. Only from a click. */
  private enableFullVoice(retried = false): void {
    this.lastVoiceAttempt = "talk";
    if (!this.voiceCapability) {
      // No welcome yet (not connected): nothing to exchange for a token — say so instead of doing nothing.
      this.reportVoiceFailure(new VoiceNotConnectedError(), "connect", "talk");
      return;
    }
    if (isWalletHolder() && this.needsConfirmedName()) {
      // The server would answer 403 name_required — confirm the name first. Listening needs no name, so
      // the same click starts it (otherwise "Not now" would leave the player with no voice at all).
      this.worldHud.chat.system(`On this server talking and presenting need a confirmed name — confirm yours (${nameFeeWords()}), then enable voice. Until then you can listen.`);
      if (this.voiceSession.connectionMode === "off") void this.enableWatchMode().catch(() => undefined);
      this.openNameModal(this.localNickname, "Confirm your name");
      return;
    }
    const wasWatching = this.voiceSession.connectionMode === "listen";
    this.voiceSession.enableVoice(this.voiceCapability).catch((error: unknown) => {
      // connect()/fetch() failure — same failure-isolation guarantee as a mic error above.
      console.warn("[voice] failed to enable voice:", error);
      const cause = classifyVoiceFailure(error, "connect", browserVoiceEnvironment());
      if (cause === "wallet_required" && isWalletHolder() && !retried) {
        // The wallet unlocked a moment ago and its set_wallet may still be on its way — tell the server
        // again and retry once before calling it a failure.
        this.network.sendWallet(true);
        window.setTimeout(() => this.enableFullVoice(true), 1200);
        return;
      }
      if (wasWatching) {
        // The upgrade failed: watch mode keeps (or goes back to) playing the stage.
        this.voiceControls.setConnectionState(this.voiceSession.connectionState, this.voiceSession.connectionMode);
      } else {
        this.voiceControls.setConnectionState("error");
      }
      this.reportVoiceFailure(error, "connect", "talk", wasWatching ? " You're still watching the stage." : "");
      // The server wants an owned name first (a registry server; the pre-check above missed it).
      if (cause === "name_required") this.openNameModal(this.localNickname, "Confirm your name");
    });
  }

  /** Watch mode: a listen-only connection, no wallet (ADR-014 § 5). Only from a click (the stage system's button). */
  private enableWatchMode(): Promise<void> {
    this.lastVoiceAttempt = "listen";
    if (!this.voiceCapability) {
      const error = new VoiceNotConnectedError();
      this.reportVoiceFailure(error, "connect", "listen");
      return Promise.reject(error);
    }
    return this.voiceSession.enableListening(this.voiceCapability).catch((error: unknown) => {
      console.warn("[voice] failed to start watch mode:", error);
      this.voiceControls.setConnectionState("error");
      this.reportVoiceFailure(error, "connect", "listen");
      throw error;
    });
  }

  /**
   * A voice, microphone or share failure becomes a precise message — the voice panel's error card (with
   * the next step as a button) and one chat line — instead of a bare "Voice: ERROR".
   */
  private reportVoiceFailure(error: unknown, stage: VoiceFailureStage, attempt: VoiceMessageContext["attempt"], suffix = ""): void {
    const cause = classifyVoiceFailure(error, stage, browserVoiceEnvironment());
    const message = voiceFailureMessage(cause, { dev: import.meta.env.DEV, host: window.location.host, attempt, mainnet: ZCASH_NETWORK === "main" });
    this.voiceControls.setError(message);
    this.worldHud.chat.system(`${message.title} ${message.detail}${suffix}`);
  }

  /** Recomputes "which remote players are currently within social interaction range" from the one reusable source of truth — see apps/web/src/social/nearby.ts. */
  private updateNearbyPlayers(): void {
    // The same radius test (nearby.ts), into the same Set every frame — no arrays per frame in a full hall.
    this.remotePlayers.nearbyIds(this.localPlayer.position, SOCIAL_INTERACTION_RADIUS_METERS, this.nearbyPlayerIds);
  }

  /** Fired by a RemotePlayerInteractable when its player is interacted with (E while nearest). */
  private onPlayerSelected(playerId: string): void {
    const player = this.remotePlayers.getPlayer(playerId);
    if (!player) return;

    this.socialStore.select(playerId);
    // Release pointer lock so the user can see and click the card's
    // buttons — the existing `pointerlockchange` listener in InputManager
    // picks this up automatically, no InputManager API needed here.
    document.exitPointerLock();

    // Anchor the menu next to the player's head on screen.
    const head = player.headPosition.project(this.camera.camera);
    const anchor = head.z <= 1 ? { x: (head.x * 0.5 + 0.5) * this.container.clientWidth, y: (1 - (head.y * 0.5 + 0.5)) * this.container.clientHeight } : undefined;
    this.playerContextCard.open(
      {
        playerId,
        nickname: player.nickname,
        // ADR-015: the avatar colour, and the one wallet-derived bit (Send ZEC only to players who can receive).
        accentColor: avatarColorCss(player.avatar.color),
        canReceive: player.canReceive,
        presence: this.nearbyPlayerIds.has(playerId) ? "nearby" : "online",
        muted: this.socialStore.isMuted(playerId),
        speaking: player.isSpeaking,
        volume: this.socialStore.getVolume(playerId),
        moderator: this.moderationStore.isTagged(playerId),
      },
      anchor,
    );
  }

  // ------------------------------------------------------------------ moderation (ADR-019)

  /** One moderation message: report acks, a moderator's results and state, notices to this session, Moderator tags. */
  private onModerationMessage(message: ModerationServerMessage): void {
    const mutedBefore = this.moderationStore.mutedUntil;
    this.moderationStore.handle(message);
    switch (message.type) {
      case "report_ack":
        if (this.reportDialog) this.reportDialog.acknowledge(message.status);
        return;
      case "mod_action_result": {
        const duration = this.lastModAction?.action === message.action ? this.lastModAction.durationMs : undefined;
        this.worldHud.chat.system(message.ok ? `🛡 ${actionDoneText(message.action, message.target, duration, message.until)}` : `🛡 ${actionErrorText(message.error ?? "invalid", message.target)}`);
        return;
      }
      case "moderation_notice":
        if (message.kind === "muted" && message.until !== undefined) {
          this.worldHud.chat.system(message.until === mutedBefore ? mutedRepeatText(message.until) : mutedText(message.until));
        }
        else if (message.kind === "unmuted") this.worldHud.chat.system("A moderator lifted your chat mute — you can chat again.");
        return;
      case "moderator_updated":
        if (message.playerId !== this.localPlayerId) {
          this.remotePlayers.setModerator(message.playerId, message.moderator);
          this.playerContextCard.setModerator(message.playerId, message.moderator);
        }
        return;
      case "mod_report":
      case "mod_log":
        return;
      default:
        message satisfies never;
        return;
    }
  }

  /** Player menu → Report: the reason, a note and what moderators see; the server answers with report_ack. */
  private openReport(playerId: string, nickname: string): void {
    this.reportDialog?.close();
    this.reportDialog = new ReportDialog({
      container: this.container,
      nickname,
      moderator: this.moderationStore.isTagged(playerId),
      send: (reason, note) => this.network.sendReport(playerId, reason, note),
      onSent: (text) => this.worldHud.chat.system(text),
      onClose: () => {
        this.reportDialog = null;
        this.renderer.domElement.focus({ preventScroll: true });
      },
    });
  }

  /** Mute… / Kick / Ban… (player menu or a report): the duration or confirmation dialog, then mod_action. */
  private openModeration(verb: ModerationVerb, target: ModerationTargetRef): void {
    if (!this.moderationStore.isModerator) return;
    this.moderationDialog?.close();
    this.moderationDialog = new ModerationActionDialog({
      container: this.container,
      verb,
      target,
      send: (message) => this.sendModAction(message),
      onClose: () => {
        this.moderationDialog = null;
      },
    });
  }

  private sendModAction(message: Omit<ModActionMessage, "type">): void {
    this.lastModAction = { action: message.action, durationMs: message.durationMs };
    this.network.sendModAction(message);
  }

  /** Profile → "Moderator sign-in": the hall's key dialog (the same field takes a host or a moderator key), from anywhere. */
  private openModeratorSignIn(): void {
    if (this.moderatorKeyDialog || this.moderationStore.isModerator) return;
    if (this.network.connectionState !== "connected" || !this.network.joined) {
      this.worldHud.chat.system("Connect to the game first, then sign in as a moderator.");
      return;
    }
    this.moderatorKeyDialog = new KeyDialog(this.container, {
      text: MODERATOR_KEY_TEXT,
      send: (key) => this.network.sendHall({ type: "hall_host_auth", key }),
      onClose: () => {
        this.moderatorKeyDialog = null;
      },
    });
  }

  // ------------------------------------------------------------------ identity (ADR-015)

  /** Onboarding finished: join as a holder (chosen character; the chosen name follows through NameConfirmation) or as a guest. */
  private enterWorld(result: OnboardingResult): void {
    const holder = result.mode === "holder" && isWalletHolder();
    this.rememberProfile({ mode: holder ? "holder" : "guest", avatar: holder ? result.avatar : null, nickname: holder ? result.nickname : null });
    if (holder && result.avatar) this.applyLocalAvatar(result.avatar); // start loading the model while the join is on its way
    this.pendingName = holder ? result.nickname : null;
    this.network.join({ wallet: isWalletHolder(), ...(holder && result.avatar ? { avatar: result.avatar } : {}) });
    this.renderer.domElement.focus({ preventScroll: true });
  }

  /** The last wallet-holder flag seen (onWalletHolderChange acts on changes only). */
  private lastHolder = false;

  /**
   * The sticky wallet-holder flag changed (participation.ts). It goes to the server as `set_wallet` (or rides on the join).
   * A guest who connects a wallet mid-session gets their remembered character and name back, or is asked for a name;
   * "Forget this wallet" turns the session back into a guest (the server sends the new Guest name and default look).
   */
  private onWalletHolderChange(holder: boolean): void {
    if (holder === this.lastHolder) return;
    this.lastHolder = holder;
    this.network.sendWallet(holder);
    this.refreshVoiceNameGate();
    if (!this.network.joinRequested || this.onboarding.isOnboarding) return; // onboarding (or the join) carries it
    if (!holder) {
      this.rememberProfile({ mode: "guest" }, false);
      this.onboarding.closeModal();
      return;
    }
    const remembered = this.profile?.lastMode === "holder" ? this.profile : null;
    if (remembered?.avatar) this.network.sendAvatar(remembered.avatar);
    if (!GUEST_NICKNAME_PATTERN.test(this.localNickname)) return; // already has a chosen name
    if (remembered?.nickname) {
      const name = remembered.nickname;
      this.applyName(name, () => this.worldHud.chat.system(`Wallet connected — you're ${name} again. Change your name or character in Profile.`));
    } else {
      // Asked when the wallet panel closes (every unlock happens there) — never over a new seed phrase.
      // Profile → "Change name" works at any time.
      this.namePromptPending = true;
      this.worldHud.chat.system("Wallet connected — you can now choose a name and character (Profile).");
    }
  }

  /** A guest who connected a wallet without a remembered name is asked for one (once), when nothing else is in the way. */
  private namePromptPending = false;
  private promptForNameIfPending(): void {
    if (!this.namePromptPending || this.walletPanel.isOpen || this.onboarding.isOpen) return;
    this.namePromptPending = false;
    if (this.localCanReceive || isWalletHolder()) {
      if (GUEST_NICKNAME_PATTERN.test(this.localNickname)) this.openNameModal("", "Choose your name");
    }
  }

  /** The server-confirmed wallet-holder flag of this session: the rename control, the Profile panel. */
  private setLocalCanReceive(canReceive: boolean): void {
    this.localCanReceive = canReceive;
    this.nicknameControls.setGuest(!canReceive);
    this.worldHud.setProfile({ holder: canReceive, accentColor: avatarColorCss(this.localAvatar?.color ?? 0) });
  }

  /**
   * Shows the local player as `avatar`: the palette accent on the placeholder (low tier) and, on the high tier, the chosen
   * KayKit model from the shared template library (the same one everyone else sees).
   */
  private applyLocalAvatar(avatar: PlayerAvatar): void {
    this.localAvatar = { ...avatar };
    this.localPlayer.setAccent(avatarColor(avatar.color));
    this.worldHud.setProfile({ holder: this.localCanReceive, accentColor: avatarColorCss(avatar.color) });
    if (!this.world.usesRiggedAvatars || this.localModelWanted === avatar.model) return;
    const wanted = avatar.model;
    this.localModelWanted = wanted;
    this.avatarLibrary
      .instantiate({ model: wanted })
      .then(({ model, clips }) => {
        if (this.localModelWanted !== wanted) return; // changed again while loading
        model.traverse((object) => {
          if ((object as THREE.Mesh).isMesh) (object as THREE.Mesh).castShadow = true; // the local player keeps its real shadow
        });
        this.localPlayer.setModel(model, clips);
      })
      .catch((error: unknown) => {
        if (this.localModelWanted === wanted) this.localModelWanted = null;
        console.warn("[player] avatar unavailable:", error);
      });
  }

  /**
   * A remembered or typed name for this session. Honour mode (ADR-015): set_nickname. ADR-016: only ever a CLAIM here
   * (a signed challenge, never a payment) — a name that isn't this wallet's yet is confirmed through the fee step
   * (Profile → Change name). A disabled registry leaves the Guest-style name.
   */
  private applyName(nickname: string, onClaimed?: () => void): void {
    const names = this.nameConfirmation;
    if (names.unavailable !== null) return;
    this.requestedName = nickname;
    if (!names.requiresFee) {
      void names.confirm(nickname).catch((error: unknown) => console.warn("[identity] name not applied:", error));
      onClaimed?.();
      return;
    }
    void names.claim(nickname).then((ok) => {
      if (ok) return onClaimed?.();
      if (this.requestedName === nickname) this.requestedName = null;
      this.worldHud.chat.system(`${nickname} isn't confirmed on this server yet — Profile → Change name confirms it (${nameFeeWords()}).`);
    });
  }

  /**
   * ADR-016: what the server runs for names (GET /zcash/info → names: off | fee | disabled, and the fee). The fee
   * flow is built once; until the answer arrives (or if it never does) names stay on ADR-015's honour system.
   */
  private async loadNameMode(): Promise<void> {
    try {
      const response = await fetch(`${gameServerOrigin()}/zcash/info`);
      if (!response.ok) return;
      const info = (await response.json()) as { names?: { mode?: unknown; feeZat?: unknown; feeUsd?: unknown }; network?: unknown; payments?: { feeZat?: unknown; capZat?: unknown; feeUsd?: unknown } };
      const mode = info.names?.mode;
      const feeZat = Number(info.names?.feeZat);
      this.nameModeKnown = true;
      // The server's payment rules, and a loud note when it runs another network than this build.
      const paymentFee = Number(info.payments?.feeZat ?? 0);
      const paymentCap = info.payments?.capZat;
      this.paymentInfo = {
        feeZat: Number.isSafeInteger(paymentFee) && paymentFee >= 0 ? paymentFee : 0,
        capZat: typeof paymentCap === "number" && Number.isSafeInteger(paymentCap) ? paymentCap : null,
        feeUsd: parseFeeUsd(info.payments?.feeUsd),
      };
      if ((info.network === "main" || info.network === "test") && info.network !== ZCASH_NETWORK) {
        this.worldHud.chat.system(`This game server runs on the Zcash ${info.network === "main" ? "mainnet" : "test chain"}, but this page was built for the ${ZCASH_NETWORK === "main" ? "mainnet" : "test chain"} — payments and names won't work. Reload, or tell the operator.`);
      }
      if (mode === "disabled") {
        this.nameConfirmation.use(disabledNameConfirmation());
      } else if (mode === "fee" && Number.isSafeInteger(feeZat) && feeZat > 0) {
        this.feeNames ??= new FeeNameConfirmation({
          network: {
            reserve: (nickname, keyHash) => this.network.sendNameReserve(nickname, keyHash),
            claimRequest: (nickname) => this.network.sendNameClaimRequest(nickname),
            claimProof: (proof) => this.network.sendNameClaimProof(proof),
            // ADR-018: the name-fee txid for the server's lightwalletd registry backend.
            paymentSent: (reservationId, txid) => this.network.sendNamePaymentSent(reservationId, txid),
            isOpen: () => this.network.socketOpen,
          },
          nameKey: () => activeNameKey(),
          subscribeNameKey: (listener) => subscribeToNameKey(() => listener()),
          wallet: {
            spendableZat: () => {
              const balance = ZcashWalletAdapter.getBalance();
              return balance ? Math.round(balance.totalZec * 1e8) : null;
            },
            sendShielded: (address, amountZec, memo) => ZcashWalletAdapter.sendShielded(address, amountZec, memo),
          },
          // No faucet on mainnet (ADR-018).
          ...(ZCASH_NETWORK === "main" ? {} : { faucet: async (credential: string | null) => (await claimTestCoins(credential)).message }),
          capability: () => this.voiceCapability,
          feeZat,
          feeUsd: parseFeeUsd(info.names?.feeUsd),
          chain: ZCASH_NETWORK,
        });
        this.nameConfirmation.use(this.feeNames);
      }
      this.refreshVoiceNameGate();
    } catch {
      // The server is unreachable: ask again when the socket connects.
    }
  }

  /** ADR-018: asks the server which client build it serves now (a split deploy may update the page without a reconnect). */
  private async checkServerBuild(): Promise<void> {
    try {
      const response = await fetch(`${gameServerOrigin()}/version`);
      if (!response.ok) return;
      const body = (await response.json()) as { build?: unknown };
      if (typeof body.build === "string") this.updatePrompt.announce(body.build);
    } catch {
      // offline: asked again later
    }
  }

  /** Our own name changed on the server: say so if it differs from what we asked for, and remember a holder's chosen name. */
  private onOwnNameChanged(nickname: string): void {
    const guestName = GUEST_NICKNAME_PATTERN.test(nickname);
    if (this.requestedName !== null && !guestName) {
      // (ADR-016: an owned name keeps the case it was registered with — that is not "taken".)
      if (nicknameKey(nickname) !== nicknameKey(this.requestedName)) this.worldHud.chat.system(`${this.requestedName} was taken — you're ${nickname}. Change it in Profile.`);
      this.requestedName = null;
    }
    if (!guestName && this.localCanReceive) this.rememberProfile({ mode: "holder", nickname });
    // The name prompt is moot once a chosen name arrived some other way (e.g. the name control).
    if (!guestName && this.onboarding.modalKind === "nickname") this.onboarding.closeModal();
  }

  /** Profile → "Change character" (holders): the character step as a modal; the server answers with avatar_updated. */
  private openCharacterModal(): void {
    if (!this.localCanReceive || !this.localAvatar) return;
    this.onboarding.openCharacter(this.localAvatar, (avatar) => this.network.sendAvatar(avatar));
  }

  /** Profile → "Change name", or the prompt after a guest connects a wallet: the nickname step as a modal (applied through NameConfirmation). */
  private openNameModal(prefill: string, title: string): void {
    if (!isWalletHolder()) return;
    document.exitPointerLock();
    this.onboarding.openNickname(GUEST_NICKNAME_PATTERN.test(prefill) ? "" : prefill, (nickname) => (this.requestedName = nickname), title);
  }

  /** Updates what this device remembers (never a Guest number, an address or anything from the wallet). */
  private rememberProfile(entered: { mode: "holder" | "guest"; avatar?: PlayerAvatar | null; nickname?: string | null }, keepRemembered = true): void {
    this.profile = profileAfterEntering(this.profile, entered, keepRemembered);
    saveProfile(this.profile);
  }

  /** Portal travel: a flash of portal light hides the jump; the player arrives facing the destination. */
  private travelTo(destination: PortalDestination): void {
    const arrival = destination.arrival;
    if (!arrival) return;
    this.portalPanel.playTravelVeil(() => {
      this.localPlayer.position.set(arrival.x, this.world.groundHeightAt(arrival.x, arrival.z), arrival.z);
      const look = destination.lookAt ?? { x: 0, z: 0 };
      const facing = Math.atan2(look.x - arrival.x, look.z - arrival.z);
      this.localPlayer.object.rotation.y = facing;
      this.camera.snapTo(facing + Math.PI, destination.cameraPitch);
    });
  }

  /** Door travel between locations: the same veil and arrival as the portal. Ids the content does not list (or lists as unavailable) do nothing. */
  private travelToId(destinationId: string): void {
    const destination = this.content.destinations.find((candidate) => candidate.id === destinationId && candidate.available);
    if (destination) this.travelTo(destination);
  }

  /** Fills the district's live boards from the community gateway (each board independently; failures show an offline face). */
  private fillCommunityBoards(): void {
    const boards = this.world.communityBoards;
    if (!boards) return;
    const fill = <T>(load: () => Promise<T>, apply: (data: T) => void, board: { setOffline(): void }): void => {
      load().then(apply).catch(() => board.setOffline());
    };
    const zec = (amount: number | null): string => (amount === null ? "ZEC" : `${Number(amount.toFixed(3))} ZEC`);
    fill(
      () => this.communityClient.bounties(),
      (listing) =>
        boards.bounties.setRows(
          [...listing.items].sort((a, b) => (b.amountZec ?? 0) - (a.amountZec ?? 0)).slice(0, 5).map((bounty) => ({ tag: zec(bounty.amountZec), text: bounty.title })),
          `${listing.items.length} open bounties · Press E to browse`,
        ),
      boards.bounties,
    );
    fill(
      () => this.communityClient.wikiIndex(),
      (listing) =>
        boards.wiki.setRows(
          listing.items.slice(0, 5).map((article) => ({ tag: article.section.split(" ")[0] ?? "", text: article.title })),
          `${listing.items.length} articles · Press E to read`,
        ),
      boards.wiki,
    );
    fill(
      () => this.communityClient.forumCategory(GRANTS_CATEGORY_ID),
      (listing) =>
        boards.forum.setRows(
          listing.items.filter((topic) => !topic.pinned).slice(0, 5).map((topic) => ({ tag: `${topic.postsCount} posts`, text: topic.title })),
          "Community Grants · Press E to read",
        ),
      boards.forum,
    );
    fill(
      () => this.communityClient.repos(),
      (listing) => boards.github.setRows(listing.items.slice(0, 5).map((repo) => ({ text: repo.fullName }))),
      boards.github,
    );
  }

  private setPhotoCamera(pose: PhotoPose | null): void {
    if (!pose) {
      this.photoCamera = null;
      return;
    }
    const camera = this.photoCamera ?? new THREE.PerspectiveCamera(pose.fov ?? 55, this.container.clientWidth / this.container.clientHeight, 0.1, 600);
    camera.fov = pose.fov ?? 55;
    camera.aspect = this.container.clientWidth / this.container.clientHeight;
    camera.position.set(...pose.position);
    camera.lookAt(...pose.target);
    camera.updateProjectionMatrix();
    this.photoCamera = camera;
  }

  private publishLocalTransform(delta: number): void {
    this.transformPublishTimer += delta;
    if (this.transformPublishTimer < App.TRANSFORM_PUBLISH_INTERVAL_SECONDS) return;
    this.transformPublishTimer = 0;

    if (this.network.connectionState !== "connected") return;

    const position = this.localPlayer.position;
    this.network.sendTransform(
      {
        x: position.x,
        y: position.y,
        z: position.z,
        rotationY: this.localPlayer.object.rotation.y,
        animationState: this.localPlayer.animation.getState(),
      },
      ++this.transformSeq,
    );
  }

  private updatePlayerCountLabel(): void {
    const total = this.network.connectionState === "connected" ? this.remotePlayers.size + 1 : this.remotePlayers.size;
    this.connectionStatus?.setPlayerCount(total);
  }

  private render(): void {
    this.renderer.render(this.world.scene, this.photoCamera ?? this.camera.camera);
    this.perf?.mark("render");
    this.localHead.copy(this.localPlayer.position).y += this.localPlayer.animation.isSeated ? 1.3 : 1.75;
    const viewCamera = this.photoCamera ?? this.camera.camera;
    // The viewport size cached at resize. Reading clientWidth here, after this frame's DOM writes
    // (HUD, then the nameplates themselves), forced the browser to lay out the page mid-frame, twice.
    this.remotePlayers.updateNameplates(viewCamera, this.viewportWidth, this.viewportHeight, this.localBubbleAnchor);
    this.floatingReactions.update(viewCamera, this.viewportWidth, this.viewportHeight, this.reactionAnchor);
    this.debugStats?.endFrame(this.renderer.webgl);
    this.perf?.mark("overlays");
  }

  /**
   * DEV / VITE_TEST_HOOKS builds only: `?perf=hall60` walks into the Watch Hall and fills it with the
   * synthetic crowd; `?perf=district` stays at the spawn. `window.__perf.summary()` reports the probe, renderer.info
   * and DOM counts; `window.__perf.reset()` starts a new measurement window (docs/architecture/PERFORMANCE.md).
   */
  private installPerfScene(kind: PerfSceneKind): void {
    const probe = this.perf;
    if (!probe) return;
    this.worldReadyAndWarm.then(() => {
      // `hallnet` — the hall filled by real networked clients (scripts/dev/hall-load.mts), no synthetic crowd.
      if (kind === "hallnet") this.travelToId(HALL_DESTINATION_ID);
      if (kind !== "hall60") return;
      const layout = this.content.hallLayout;
      if (!layout) return;
      this.travelToId(HALL_DESTINATION_ID);
      this.perfScene = new HallPerfScene({
        spawn: (summary) => this.remotePlayers.spawn(summary),
        has: (playerId) => this.remotePlayers.getPlayer(playerId) !== undefined,
        receiveTransform: (message) => this.remotePlayers.receiveTransform(message),
        hallState: () => {
          const hall = this.hallStore;
          return { stage: hall.stage, seats: [...hall.seats], hands: [...hall.hands], floor: hall.floor, hosts: [...hall.hosts], host: hall.isHost, totals: { ...hall.reactionTotals }, session: hall.reactionSession, vote: hall.vote };
        },
        applyHallState: (message) => this.hallStore.apply(message),
        occupant: (seatId) => this.hallStore.occupantOf(seatId),
      }, layout);
    });
    const summary = () => {
      const info = this.renderer.webgl.info;
      let pointLights = 0;
      this.world.scene.traverseVisible((object) => {
        if ((object as THREE.PointLight).isPointLight) pointLights++;
      });
      const plates = Array.from(this.container.querySelectorAll<HTMLElement>(".zw-nameplate"));
      return {
        scene: kind,
        quality: this.renderer.quality,
        viewport: { width: this.container.clientWidth, height: this.container.clientHeight, pixelRatio: this.renderer.webgl.getPixelRatio() },
        resolutionScale: this.renderer.currentResolutionScale,
        msaa: this.renderer.msaaActive,
        ...probe.summary(),
        renderer: { calls: info.render.calls, triangles: info.render.triangles, programs: info.programs?.length ?? 0, geometries: info.memory.geometries, textures: info.memory.textures },
        pointLights,
        pointLightPool: this.world.pointLightPool ? { size: this.world.pointLightPool.size, used: this.world.pointLightPool.used } : null,
        remotePlayers: this.remotePlayers.size,
        dom: { nodes: document.getElementsByTagName("*").length, nameplates: plates.length, nameplatesShown: plates.filter((plate) => plate.style.display !== "none").length },
      };
    };
    (window as unknown as { __perf: { summary: typeof summary; reset: () => void; ready: () => boolean; renderer: Renderer } }).__perf = {
      summary,
      reset: () => probe.reset(),
      // For measurement scripts that toggle one cost at a time (shadows, MSAA, bloom) — docs/architecture/PERFORMANCE.md.
      renderer: this.renderer,
      ready: () => kind === "district" || kind === "hallnet" || (this.perfScene !== null && this.remotePlayers.size >= this.perfScene.playerCount),
    };
  }

  private onResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.renderer.resize(width, height);
    this.camera.setAspect(width / height);
  };

  dispose(): void {
    this.gameLoop.stop();
    window.removeEventListener("resize", this.onResize);
    if (this.unsubscribeVoiceParticipation) {
      this.unsubscribeVoiceParticipation();
      this.unsubscribeVoiceParticipation = null;
    }
    this.unsubscribeWalletHolder?.();
    this.unsubscribeWalletHolder = null;
    this.onboarding.dispose();
    this.network.disconnect();
    this.remotePlayers.clear();
    this.nameplates.dispose();
    this.connectionStatus?.dispose();
    this.playerContextCard.dispose();
    this.walletPanel.dispose();
    this.worldHud.dispose();
    this.communityPanel.dispose();
    this.watchPanel.dispose();
    this.personalPlayer.dispose();
    this.portalPanel.dispose();
    this.learningPanel.dispose();
    this.projectDiscoveryPanel.dispose();
    this.nicknameControls.dispose();
    this.hallBoards.dispose();
    this.stageWidget.dispose();
    this.discussionMenu.dispose();
    this.speakerCard.dispose();
    this.seats.dispose();
    this.hallPresence.dispose();
    this.emotes.dispose();
    this.floatingReactions.dispose();
    this.stage.dispose();
    this.moderationPanel.dispose();
    this.removedOverlay.hide();
    this.voiceSession.dispose();
    this.voiceControls.dispose();
    this.input.dispose();
    this.assetManager.dispose();
    this.renderer.dispose();
  }
}

/** Why Profile → "Moderator sign-in" failed (the server answers through the hall's host-key errors). */
function moderatorSignInError(reason: HallErrorReason): string {
  switch (reason) {
    case "bad_key":
    case "not_in_hall":
      return "That isn't a moderator key. (A Watch Hall host key works inside the hall.)";
    case "rate_limited":
      return "Too many attempts — reload the page to try again.";
    case "host_disabled":
      return "Moderator sign-in isn't set up on this server.";
    default:
      return "The key wasn't accepted.";
  }
}

/** How the name fee is described in chat — real ZEC on a mainnet build, test coins otherwise. */
function nameFeeWords(): string {
  return ZCASH_NETWORK === "main" ? "a small fee in ZEC" : "a small test-coin fee";
}
