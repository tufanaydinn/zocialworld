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
import { ConnectionStatus } from "../ui/ConnectionStatus.ts";
import { NameplateManager } from "../ui/Nameplates.ts";
import { NetworkClient } from "../networking/NetworkClient.ts";
import { RemotePlayerManager } from "../networking/RemotePlayerManager.ts";
import { getWebSocketUrl } from "../networking/config.ts";
import { SocialStore } from "../social/SocialStore.ts";
import { PlayerContextCard } from "../social/PlayerContextCard.ts";
import { NicknameControls } from "../social/NicknameControls.ts";
import { getNearbyPlayers, SOCIAL_INTERACTION_RADIUS_METERS } from "../social/nearby.ts";
import { VoiceSession } from "../voice/VoiceSession.ts";
import { VoiceControls } from "../voice/VoiceControls.ts";

/**
 * Top-level composition root.
 *
 * App wires every system together but contains almost no logic of its
 * own — it creates each module, hands the handful of cross-cutting
 * dependencies between them (e.g. "the camera needs the world's
 * obstacle list", "the player controller needs the camera's yaw"), and
 * drives them from one GameLoop. Any future agent extending a single
 * system (camera, player, world, UI, networking) should not need to
 * touch this file except to add one new wiring line.
 *
 * See docs/OVERVIEW.md for the full data-flow diagram.
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
  private readonly world: World;

  private readonly interactionPrompt: InteractionPrompt;
  private readonly projectDiscoveryPanel: ProjectDiscoveryPanel;
  private readonly debugStats: DebugStats | null;
  private readonly connectionStatus: ConnectionStatus | null;

  private readonly nameplates: NameplateManager;
  private readonly remotePlayers: RemotePlayerManager;
  private readonly network: NetworkClient;
  private transformPublishTimer = 0;
  private transformSeq = 0;

  private readonly socialStore = new SocialStore();
  private readonly playerContextCard: PlayerContextCard;
  private readonly nicknameControls: NicknameControls;
  private localPlayerId: string | null = null;
  /** CORE-004 security revision: owner-only, from `welcome` — the only thing `enableVoice()` ever sends to `/voice/token`. Never a client-asserted playerId/nickname — see VoiceSession.enableVoice()'s docstring. */
  private voiceCapability: string | null = null;
  private nearbyPlayerIds = new Set<string>();

  private readonly voiceSession: VoiceSession;
  private readonly voiceControls: VoiceControls;
  private pushToTalkWasPressed = false;

  private readonly gameLoop: GameLoop;

  /** Network transforms publish at ~10 Hz, not render FPS — see docs/protocols/multiplayer-protocol.md § Network rate. */
  private static readonly TRANSFORM_PUBLISH_INTERVAL_SECONDS = 0.1;

  constructor(container: HTMLElement) {
    this.container = container;

    this.renderer = new Renderer(container);
    this.input = new InputManager(this.renderer.domElement);
    this.camera = new ThirdPersonCamera(container.clientWidth / container.clientHeight);

    // HUD is self-contained (just paints static DOM chrome) — no state to hold onto yet.
    new HUD(container);
    this.interactionPrompt = new InteractionPrompt(container);
    this.projectDiscoveryPanel = new ProjectDiscoveryPanel(container);
    this.interactions.onNearestChange((nearest) => {
      if (nearest) this.interactionPrompt.show(nearest.label);
      else this.interactionPrompt.hide();
    });

    this.world = new World({
      collisions: this.collisions,
      interactions: this.interactions,
      onOpenProjectBoard: () => this.projectDiscoveryPanel.open(),
      onSelectProject: (projectId) => this.projectDiscoveryPanel.openProject(projectId),
    });
    this.camera.setObstacles(() => this.world.cameraObstacles);

    this.localPlayer.position.copy(this.world.spawnPoint);
    this.world.scene.add(this.localPlayer.object);

    this.playerController = new PlayerController(
      this.input,
      this.collisions,
      this.localPlayer,
      () => this.camera.currentYaw,
    );

    this.nameplates = new NameplateManager(container);
    this.remotePlayers = new RemotePlayerManager({
      scene: this.world.scene,
      nameplates: this.nameplates,
      interactions: this.interactions,
      interactionRadius: SOCIAL_INTERACTION_RADIUS_METERS,
      onPlayerSelected: (playerId) => this.onPlayerSelected(playerId),
    });

    this.playerContextCard = new PlayerContextCard(container);
    this.playerContextCard.onBlock((playerId) => {
      this.socialStore.block(playerId);
      this.remotePlayers.setBlocked(playerId, true);
      this.playerContextCard.close();
    });
    this.playerContextCard.onMuteToggle((playerId, muted) => {
      // CORE-004 §19: local-only — never transmitted to the server or the muted player. See SocialStore.mute()'s docstring.
      if (muted) this.socialStore.mute(playerId);
      else this.socialStore.unmute(playerId);
    });

    this.nicknameControls = new NicknameControls(container);
    this.nicknameControls.onNicknameSubmit((nickname) => {
      if (this.network.connectionState === "connected") this.network.sendNickname(nickname);
    });

    this.voiceSession = new VoiceSession(
      {
        camera: this.camera.camera,
        getRemotePlayerObject: (playerId) => this.remotePlayers.getPlayer(playerId)?.object,
        isMuted: (playerId) => this.socialStore.isMuted(playerId),
        isBlocked: (playerId) => this.socialStore.isBlocked(playerId),
      },
      {
        onStateChange: (state) => this.voiceControls.setConnectionState(state),
        onSpeakingChanged: (playerId, speaking) => {
          if (playerId === this.localPlayerId) return; // CORE-004 §25: no self-voice UI beyond the mic-active label VoiceControls already shows
          this.remotePlayers.setSpeaking(playerId, speaking);
        },
        onMicrophoneError: (error) => {
          // Voice failure must never break the rest of the app (CORE-004
          // §28) — logged for diagnosis only, never surfaced as a crash.
          console.warn("[voice] microphone unavailable:", error);
        },
      },
    );
    this.voiceControls = new VoiceControls(container);
    this.voiceControls.setConnectionState("disconnected");
    this.voiceControls.onEnable(() => {
      if (!this.voiceCapability) return; // no welcome received yet (not connected) — nothing to exchange for a token
      this.voiceSession.enableVoice(this.voiceCapability).catch((error) => {
        // connect()/fetch() failure (e.g. voice disabled server-side, 503) — same failure-isolation guarantee as a mic error above.
        console.warn("[voice] failed to enable voice:", error);
        this.voiceControls.setConnectionState("error");
      });
    });

    this.network = new NetworkClient(getWebSocketUrl(), {
      onStateChange: (state) => {
        this.connectionStatus?.setState(state);
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
        }
        this.updatePlayerCountLabel();
      },
      onWelcome: (message) => {
        this.localPlayerId = message.playerId;
        this.nicknameControls.setCurrentNickname(message.nickname);
        // CORE-004 security revision: a (re)connect always gets a fresh
        // capability (see WorldServer.handleJoin) — stale on disconnect,
        // see onStateChange's "disconnected" branch above.
        this.voiceCapability = message.voiceCapability;
      },
      onSnapshot: (message) => {
        for (const player of message.players) this.remotePlayers.spawn(player);
        this.updatePlayerCountLabel();
      },
      onPlayerJoined: (message) => {
        this.remotePlayers.spawn(message);
        this.updatePlayerCountLabel();
      },
      onPlayerLeft: (message) => {
        this.remotePlayers.despawn(message.playerId);
        this.updatePlayerCountLabel();
      },
      onPlayerTransform: (message) => this.remotePlayers.receiveTransform(message),
      onNicknameUpdated: (message) => {
        if (message.playerId === this.localPlayerId) {
          this.nicknameControls.setCurrentNickname(message.nickname);
        } else {
          this.remotePlayers.updateNickname(message.playerId, message.nickname);
        }
      },
    });
    this.network.connect();

    this.debugStats = import.meta.env.DEV ? new DebugStats(container) : null;
    this.connectionStatus = import.meta.env.DEV ? new ConnectionStatus(container) : null;
    if (import.meta.env.DEV) {
      // Convenience hooks for debugging and for the Character/Asset agents
      // to poke from devtools without wiring a temporary UI button.
      (window as unknown as { __assetManager: AssetManager }).__assetManager = this.assetManager;
      (window as unknown as { __localPlayer: LocalPlayer }).__localPlayer = this.localPlayer;
      (window as unknown as { __networkClient: NetworkClient }).__networkClient = this.network;
      (window as unknown as { __remotePlayers: RemotePlayerManager }).__remotePlayers = this.remotePlayers;
      (window as unknown as { __socialStore: SocialStore }).__socialStore = this.socialStore;
      (window as unknown as { __voiceSession: VoiceSession }).__voiceSession = this.voiceSession;
      // CORE-005 § 31 Test 13: lets tests/e2e/projects.spec.ts call
      // showDetailForTesting() with hostile content through the real render path.
      (window as unknown as { __projectDiscoveryPanel: ProjectDiscoveryPanel }).__projectDiscoveryPanel = this.projectDiscoveryPanel;
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

  private update(delta: number): void {
    this.debugStats?.beginFrame();

    this.camera.update(delta, this.input, this.localPlayer.position, this.localPlayer.height);
    this.playerController.update(delta);
    this.interactions.update(this.localPlayer.position, this.input);
    this.remotePlayers.update(delta);
    this.publishLocalTransform(delta);
    this.updateNearbyPlayers();
    this.updateVoice();

    if (this.input.wasJustPressed("menu")) {
      if (this.projectDiscoveryPanel.isOpen) this.projectDiscoveryPanel.close();
      if (this.playerContextCard.isOpen) this.playerContextCard.close();
    }

    this.input.endFrame();
  }

  /** CORE-004 §16: push-to-talk polling (held V → transmit) + per-frame distance-gain recompute for every subscribed remote voice track. A no-op before `enableVoice()` has ever succeeded — see VoiceClient.setTransmitting()/VoiceSession.update(). */
  private updateVoice(): void {
    const pushToTalkPressed = this.input.isPressed("pushToTalk");
    if (pushToTalkPressed !== this.pushToTalkWasPressed) {
      this.pushToTalkWasPressed = pushToTalkPressed;
      this.voiceSession.setTransmitting(pushToTalkPressed).catch((error) => {
        console.warn("[voice] failed to toggle transmit state:", error);
      });
      this.voiceControls.setMicActive(pushToTalkPressed);
    }
    this.voiceSession.update(this.localPlayer.position);
  }

  /** CORE-003: recomputes "which remote players are currently within social interaction range" from the one reusable source of truth — see apps/web/src/social/nearby.ts. */
  private updateNearbyPlayers(): void {
    const nearby = getNearbyPlayers(this.localPlayer.position, this.remotePlayers.getPositions(), SOCIAL_INTERACTION_RADIUS_METERS);
    this.nearbyPlayerIds = new Set(nearby.map((player) => player.playerId));
  }

  /** CORE-003: fired by a RemotePlayerInteractable when its player is interacted with (E while nearest). */
  private onPlayerSelected(playerId: string): void {
    const player = this.remotePlayers.getPlayer(playerId);
    if (!player) return;

    this.socialStore.select(playerId);
    // Release pointer lock so the user can see and click the card's
    // buttons — the existing `pointerlockchange` listener in InputManager
    // picks this up automatically, no InputManager API needed here.
    document.exitPointerLock();

    this.playerContextCard.open({
      playerId,
      nickname: player.nickname,
      colorSeed: player.colorSeed,
      presence: this.nearbyPlayerIds.has(playerId) ? "nearby" : "online",
      muted: this.socialStore.isMuted(playerId),
    });
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
    this.renderer.render(this.world.scene, this.camera.camera);
    this.remotePlayers.updateNameplates(this.camera.camera, this.container.clientWidth, this.container.clientHeight);
    this.debugStats?.endFrame(this.renderer.webgl);
  }

  private onResize = (): void => {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    this.renderer.resize(width, height);
    this.camera.setAspect(width / height);
  };

  dispose(): void {
    this.gameLoop.stop();
    window.removeEventListener("resize", this.onResize);
    this.network.disconnect();
    this.remotePlayers.clear();
    this.nameplates.dispose();
    this.connectionStatus?.dispose();
    this.playerContextCard.dispose();
    this.projectDiscoveryPanel.dispose();
    this.nicknameControls.dispose();
    this.voiceSession.disableVoice();
    this.voiceControls.dispose();
    this.input.dispose();
    this.assetManager.dispose();
    this.renderer.dispose();
  }
}
