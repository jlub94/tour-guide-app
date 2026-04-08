/**
 * App.tsx
 *
 * Root component for the Roamio Walking Tour app.
 *
 * Triggering logic:
 *  • A story fires when BOTH: user has moved ≥ 15 m from last narration point
 *    AND at least 45 s have elapsed since the last story.
 *  • If 2 minutes pass with no story, one fires regardless of movement.
 *  • Regenerate button fires a story immediately, bypassing distance/time checks.
 *  • A location is 'covered' after 4 stories — no new stories until 50 m moved.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  ActivityIndicator,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Path } from 'react-native-svg';

import { StoryEntry, generateStory } from './src/ai';
import {
  LocationData,
  calculateDistance,
  requestLocationPermissions,
  reverseGeocode,
  startLocationTracking,
  stopLocationTracking,
} from './src/location';
import { speak, stopAudio, stopSpeaking } from './src/tts';

// ─── Constants ────────────────────────────────────────────────────────────────

const MIN_DISTANCE_M   = 15;        // metres — minimum move before trigger
const MIN_TIME_MS      = 45_000;    // ms    — minimum time between stories
const MAX_SILENCE_MS   = 120_000;   // ms    — fire regardless if this elapses
const GEOCODE_UPDATE_M = 15;        // metres — re-geocode the location pill

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function excerpt(text: string, maxChars = 60): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars).trimEnd() + '…';
}

// ─── Icon ─────────────────────────────────────────────────────────────────────

function RoamioIcon() {
  const c  = '#26215C';
  const sw = 2.5;
  return (
    <Svg width={56} height={56} viewBox="0 0 56 56" fill="none">
      {/* Left panel */}
      <Path
        d="M 4,27 L 16,23 L 16,50 L 4,47 Z"
        stroke={c} strokeWidth={sw} strokeLinejoin="round" fill="none"
      />
      {/* Centre panel — bottom comes to a V-point at (28,54) */}
      <Path
        d="M 16,23 L 40,23 L 40,50 L 28,54 L 16,50 Z"
        stroke={c} strokeWidth={sw} strokeLinejoin="round" fill="none"
      />
      {/* Right panel */}
      <Path
        d="M 40,23 L 52,27 L 52,47 L 40,50 Z"
        stroke={c} strokeWidth={sw} strokeLinejoin="round" fill="none"
      />
      {/* Pin — teardrop outline */}
      <Path
        d="M 28,22 C 24,18 21,15 21,10 A 7,7 0 1,1 35,10 C 35,15 32,18 28,22 Z"
        stroke={c} strokeWidth={sw} strokeLinejoin="round" fill="none"
      />
      {/* Pin — circle cutout */}
      <Circle cx={28} cy={10} r={3} stroke={c} strokeWidth={sw} fill="none" />
    </Svg>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function App() {

  // ── State ──────────────────────────────────────────────────────────────────

  const [isRunning,          setIsRunning]          = useState(false);
  const [isMuted,            setIsMuted]            = useState(false);
  const [isLoading,          setIsLoading]          = useState(false);
  const [storyLog,           setStoryLog]           = useState<StoryEntry[]>([]);
  const [lastStory,          setLastStory]          = useState<string>('');
  const [statusMessage,      setStatusMessage]      = useState<string>('Press Start to begin your tour.');
  const [errorMessage,       setErrorMessage]       = useState<string>('');
  const [resolvedPlaceName,  setResolvedPlaceName]  = useState<string | null>(null);
  const [logModalVisible,    setLogModalVisible]    = useState(false);
  const [helpModalVisible,   setHelpModalVisible]   = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────────────

  const historyRef                  = useRef<StoryEntry[]>([]);
  const lastNarrationLocationRef    = useRef<LocationData | null>(null);
  const lastNarrationTimeRef        = useRef<number>(0);
  const isBusyRef                   = useRef(false);
  const currentLocationRef          = useRef<LocationData | null>(null);
  const isRunningRef                = useRef(false);
  const isMutedRef                  = useRef(false);
  const totalStoriesRef             = useRef<number>(0);
  const storiesAtCurrentLocationRef = useRef<number>(0);
  const locationCoveredRef          = useRef<boolean>(false);
  const locationAnchorRef           = useRef<LocationData | null>(null);
  const lastGeocodedLocationRef     = useRef<LocationData | null>(null);

  // ── Animations ─────────────────────────────────────────────────────────────

  // Location pill pulse (while resolving)
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!isRunning || resolvedPlaceName) {
      pulseAnim.setValue(1);
      return;
    }
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 700, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [isRunning, resolvedPlaceName, pulseAnim]);


  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);

  // ── Core trigger logic ─────────────────────────────────────────────────────

  const triggerStory = useCallback(async (location: LocationData) => {
    console.log('[App] triggerStory called — isRunning:', isRunningRef.current, 'busy:', isBusyRef.current);
    if (!isRunningRef.current) return;
    if (isBusyRef.current)     return;
    if (locationCoveredRef.current) {
      console.log('[App] Location covered (4 stories told here) — skipping until user moves 50 m.');
      return;
    }

    isBusyRef.current = true;
    setIsLoading(true);
    setErrorMessage('');

    try {
      setStatusMessage('Generating narration…');

      const geocoded = await reverseGeocode(location.latitude, location.longitude);
      if (geocoded) {
        setResolvedPlaceName(geocoded.formatted);
        lastGeocodedLocationRef.current = location;
      }

      const text = await generateStory(
        location.latitude,
        location.longitude,
        historyRef.current,
        geocoded?.formatted,
        totalStoriesRef.current,
        storiesAtCurrentLocationRef.current
      );

      const entry: StoryEntry = {
        story:     text,
        latitude:  location.latitude,
        longitude: location.longitude,
        timestamp: Date.now(),
        placeName: geocoded?.formatted,
      };

      historyRef.current = [...historyRef.current, entry];
      lastNarrationLocationRef.current = location;
      lastNarrationTimeRef.current = Date.now();

      totalStoriesRef.current += 1;
      storiesAtCurrentLocationRef.current += 1;

      if (!locationAnchorRef.current) {
        locationAnchorRef.current = location;
      }
      if (storiesAtCurrentLocationRef.current >= 4) {
        locationCoveredRef.current = true;
        console.log('[App] Location covered — 4 stories told here. Waiting for 50 m movement.');
      }

      setLastStory(text);
      setStoryLog((prev) => [entry, ...prev].slice(0, 5));
      setStatusMessage('Playing narration…');

      await speak(text, isMutedRef.current);
      setStatusMessage('Walking… listening for your next move.');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[App] triggerStory error:', msg);
      setErrorMessage(msg);
      setStatusMessage('Error — will retry on next trigger.');
    } finally {
      isBusyRef.current = false;
      setIsLoading(false);
    }
  }, []);

  const handleLocationUpdate = useCallback((location: LocationData) => {
    console.log('[App] handleLocationUpdate called — isRunning:', isRunningRef.current);
    currentLocationRef.current = location;

    if (!isRunningRef.current) return;

    // Re-geocode for the location pill when the user moves far enough.
    const lastGeo = lastGeocodedLocationRef.current;
    const geoDist = lastGeo
      ? calculateDistance(lastGeo.latitude, lastGeo.longitude, location.latitude, location.longitude)
      : Infinity;
    if (geoDist >= GEOCODE_UPDATE_M) {
      lastGeocodedLocationRef.current = location;
      reverseGeocode(location.latitude, location.longitude).then((result) => {
        if (result) setResolvedPlaceName(result.formatted);
      });
    }

    // 50 m anchor check — reset per-location counter if user has moved far enough.
    const anchor = locationAnchorRef.current;
    if (anchor) {
      const distFromAnchor = calculateDistance(
        anchor.latitude, anchor.longitude,
        location.latitude, location.longitude
      );
      if (distFromAnchor >= 50) {
        console.log(`[App] Moved ${distFromAnchor.toFixed(1)} m from anchor — resetting location counter.`);
        storiesAtCurrentLocationRef.current = 0;
        locationCoveredRef.current = false;
        locationAnchorRef.current = location;
      }
    }

    // Distance + time trigger.
    const now = Date.now();
    const timeSinceLast = now - lastNarrationTimeRef.current;
    const lastLoc = lastNarrationLocationRef.current;
    const distance = lastLoc
      ? calculateDistance(lastLoc.latitude, lastLoc.longitude, location.latitude, location.longitude)
      : Infinity;

    const movedEnough  = distance >= MIN_DISTANCE_M;
    const waitedEnough = timeSinceLast >= MIN_TIME_MS;

    console.log(
      `[App] Trigger check — distance: ${distance === Infinity ? '∞' : distance.toFixed(1) + 'm'}, ` +
      `timeSinceLast: ${(timeSinceLast / 1000).toFixed(1)}s, ` +
      `movedEnough: ${movedEnough}, waitedEnough: ${waitedEnough}, busy: ${isBusyRef.current}`
    );

    if (movedEnough && waitedEnough) {
      console.log('[App] Both conditions met — firing triggerStory');
      triggerStory(location);
    }
  }, [triggerStory]);

  // ── Silence-prevention interval ────────────────────────────────────────────

  useEffect(() => {
    if (!isRunning) return;
    const interval = setInterval(() => {
      if (!isRunningRef.current || isBusyRef.current) return;
      const timeSinceLast = Date.now() - lastNarrationTimeRef.current;
      if (timeSinceLast >= MAX_SILENCE_MS && currentLocationRef.current) {
        triggerStory(currentLocationRef.current);
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [isRunning, triggerStory]);

  // ── Start / Stop ───────────────────────────────────────────────────────────

  const handleStart = useCallback(async () => {
    console.log('[App] Start button pressed');
    setErrorMessage('');
    setStatusMessage('Requesting location permissions…');

    const granted = await requestLocationPermissions();
    if (!granted) {
      setErrorMessage('Location permission is required. Please grant it in Settings.');
      setStatusMessage('Stopped.');
      return;
    }

    historyRef.current                  = [];
    lastNarrationLocationRef.current    = null;
    lastNarrationTimeRef.current        = 0;
    isBusyRef.current                   = false;
    totalStoriesRef.current             = 0;
    storiesAtCurrentLocationRef.current = 0;
    locationCoveredRef.current          = false;
    locationAnchorRef.current           = null;
    lastGeocodedLocationRef.current     = null;
    setStoryLog([]);
    setLastStory('');
    setResolvedPlaceName(null);

    isRunningRef.current = true;
    setIsRunning(true);
    setStatusMessage('GPS locked — start walking!');

    console.log('[App] Calling startLocationTracking...');
    await startLocationTracking(handleLocationUpdate);
    console.log('[App] startLocationTracking returned');
  }, [handleLocationUpdate]);

  const handleStop = useCallback(async () => {
    // Stop audio immediately — before any other teardown.
    await stopAudio();

    isRunningRef.current = false;
    setIsRunning(false);
    stopLocationTracking();
    isBusyRef.current = false;
    setIsLoading(false);
    setStatusMessage('Tour stopped. Press Start to begin again.');
  }, []);

  // ── Regenerate ─────────────────────────────────────────────────────────────

  const handleRegenerate = useCallback(() => {
    const loc = currentLocationRef.current;
    if (!loc) return;
    triggerStory(loc);
  }, [triggerStory]);

  // ── Mute toggle ────────────────────────────────────────────────────────────

  const handleMuteToggle = useCallback(async () => {
    const nowMuted = !isMuted;
    setIsMuted(nowMuted);
    if (nowMuted) {
      // Muting: cut audio immediately.
      await stopAudio();
    } else {
      // Unmuting: restart TTS with the currently displayed narration.
      if (lastStory) {
        speak(lastStory, false).catch(console.error);
      }
    }
  }, [isMuted, lastStory]);

  // ── JSX ────────────────────────────────────────────────────────────────────

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="dark-content" backgroundColor={colors.bg} />

        {/* ── Header ── */}
        <View style={styles.header}>
          <RoamioIcon />
          <Text style={styles.headerTitle}>Roamio</Text>
          <TouchableOpacity
            style={styles.helpButton}
            onPress={() => setHelpModalVisible(true)}
            activeOpacity={0.75}
          >
            <Text style={styles.helpButtonText}>?</Text>
          </TouchableOpacity>
        </View>

        {/* ── Scrollable content ── */}
        <ScrollView
          style={styles.scrollArea}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Location pill */}
          {isRunning && (
            <View style={styles.pillRow}>
              {resolvedPlaceName ? (
                <View style={styles.pill}>
                  <Text style={styles.pillText}>{resolvedPlaceName}</Text>
                </View>
              ) : (
                <Animated.View style={[styles.pill, { opacity: pulseAnim }]}>
                  <Text style={styles.pillText}>Resolving location…</Text>
                </Animated.View>
              )}
            </View>
          )}

          {/* Status pill */}
          <View style={styles.statusRow}>
            {isRunning && <View style={styles.trackingDot} />}
            {isLoading && (
              <ActivityIndicator color={colors.accent} style={styles.spinner} size="small" />
            )}
            <View style={styles.pill}>
              <Text style={styles.pillText}>{statusMessage}</Text>
            </View>
          </View>
          {!!errorMessage && (
            <Text style={styles.errorText}>{errorMessage}</Text>
          )}

          {/* map goes here */}

          {/* Latest narration */}
          <View style={[styles.card, styles.storyCard]}>
            <Text style={styles.cardLabel}>LATEST NARRATION</Text>
            <ScrollView
              style={styles.storyScroll}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled
            >
              <Text style={styles.storyText}>
                {lastStory || 'Your tour narration will appear here…'}
              </Text>
            </ScrollView>
          </View>

          {/* Story log (tappable — opens modal) */}
          {storyLog.length > 0 && (
            <TouchableOpacity
              style={[styles.card, styles.logCard]}
              onPress={() => setLogModalVisible(true)}
              activeOpacity={0.8}
            >
              <Text style={styles.cardLabel}>STORY LOG — tap to expand</Text>
              {storyLog.map((entry, idx) => (
                <View
                  key={entry.timestamp}
                  style={[styles.logEntry, idx === storyLog.length - 1 && styles.logEntryLast]}
                >
                  <Text style={styles.logPlace}>
                    {entry.placeName ?? `${entry.latitude.toFixed(4)}, ${entry.longitude.toFixed(4)}`}
                  </Text>
                  <Text style={styles.logSnippet}>{excerpt(entry.story)}</Text>
                </View>
              ))}
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* ── Controls (fixed at bottom) ── */}
        <View style={styles.controls}>
          <View style={styles.controlsRow}>
            <TouchableOpacity
              style={[styles.muteButton, isMuted && styles.mutedButton]}
              onPress={handleMuteToggle}
              activeOpacity={0.75}
            >
              <Text style={styles.muteButtonText}>{isMuted ? '🔇' : '🔊'}</Text>
            </TouchableOpacity>

            {isRunning ? (
              <TouchableOpacity style={styles.stopButton} onPress={handleStop} activeOpacity={0.75}>
                <Text style={styles.stopButtonText}>■  Stop Tour</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={styles.startButton} onPress={handleStart} activeOpacity={0.75}>
                <Text style={styles.startButtonText}>▶  Start Tour</Text>
              </TouchableOpacity>
            )}
          </View>

          {isRunning && (
            <TouchableOpacity
              style={styles.regenerateButton}
              onPress={handleRegenerate}
              activeOpacity={0.75}
            >
              <Text style={styles.regenerateButtonText}>↺  Regenerate</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── Story Log Modal ── */}
        <Modal
          visible={logModalVisible}
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setLogModalVisible(false)}
        >
          <SafeAreaView style={styles.modalSafe}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Story Log</Text>
              <TouchableOpacity
                style={styles.modalCloseButton}
                onPress={() => setLogModalVisible(false)}
                activeOpacity={0.75}
              >
                <Text style={styles.modalCloseText}>✕</Text>
              </TouchableOpacity>
            </View>
            <ScrollView
              style={styles.modalScroll}
              contentContainerStyle={styles.modalScrollContent}
              showsVerticalScrollIndicator={false}
            >
              {storyLog.map((entry, idx) => (
                <View key={entry.timestamp} style={styles.modalEntry}>
                  <View style={styles.modalEntryHeader}>
                    <Text style={styles.modalEntryPlace}>
                      {entry.placeName ?? `${entry.latitude.toFixed(4)}, ${entry.longitude.toFixed(4)}`}
                    </Text>
                    <Text style={styles.modalEntryTime}>{formatTime(entry.timestamp)}</Text>
                  </View>
                  <Text style={styles.modalEntryStory}>{entry.story}</Text>
                  {idx < storyLog.length - 1 && <View style={styles.modalDivider} />}
                </View>
              ))}
            </ScrollView>
          </SafeAreaView>
        </Modal>

        {/* ── Help Modal ── */}
        <Modal
          visible={helpModalVisible}
          animationType="fade"
          transparent
          onRequestClose={() => setHelpModalVisible(false)}
        >
          <View style={styles.helpOverlay}>
            <View style={styles.helpModal}>
              <Text style={styles.helpTitle}>How to use Roamio</Text>
              <Text style={styles.helpBody}>
                Tap <Text style={styles.helpEmphasis}>Start Tour</Text> and begin walking.
                Roamio will narrate stories about your surroundings as you move.{'\n\n'}
                Tap <Text style={styles.helpEmphasis}>Regenerate</Text> to get a new story
                at your current location.{'\n\n'}
                Tap the <Text style={styles.helpEmphasis}>Story Log</Text> to review what
                you have heard.{'\n\n'}
                Tap <Text style={styles.helpEmphasis}>Stop Tour</Text> to end your session.
              </Text>
              <TouchableOpacity
                style={styles.helpCloseButton}
                onPress={() => setHelpModalVisible(false)}
                activeOpacity={0.75}
              >
                <Text style={styles.helpCloseText}>Got it</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ─── Design tokens ────────────────────────────────────────────────────────────

const colors = {
  bg:           '#F5F0E8',
  surface:      '#FBF8F2',
  border:       '#D3C9B2',
  primaryText:  '#26215C',
  mutedText:    '#888780',
  bodyText:     '#444441',
  accent:       '#534AB7',
  accentBg:     '#EEEDFE',
  accentDim:    '#AFA9EC',
  startBg:      '#3C3489',
  startText:    '#EEEDFE',
  stopBg:       '#993C1D',
  stopText:     '#FAECE7',
  trackingDot:  '#1D9E75',
  error:        '#993C1D',
};

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // ── Header ──
  header: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerTitle: {
    color:      colors.primaryText,
    fontSize:   32,
    fontWeight: '500',
    marginTop:  6,
  },
  helpButton: {
    position:        'absolute',
    top:             16,
    right:           16,
    width:           32,
    height:          32,
    borderRadius:    16,
    backgroundColor: colors.accentBg,
    borderWidth:     1,
    borderColor:     colors.accentDim,
    alignItems:      'center',
    justifyContent:  'center',
  },
  helpButtonText: {
    color:      colors.accent,
    fontSize:   16,
    fontWeight: '700',
    lineHeight: 20,
  },

  // ── Scrollable content ──
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 8,
  },

  // ── Pills ──
  pillRow: {
    flexDirection:    'row',
    paddingHorizontal: 16,
    marginBottom:     4,
  },
  statusRow: {
    flexDirection:    'row',
    alignItems:       'center',
    paddingHorizontal: 16,
    marginBottom:     6,
    gap:              8,
  },
  pill: {
    backgroundColor:  colors.accentBg,
    borderRadius:     20,
    paddingHorizontal: 14,
    paddingVertical:   6,
    alignSelf:        'flex-start',
  },
  pillText: {
    color:      colors.accent,
    fontSize:   12,
    fontWeight: '500',
  },
  trackingDot: {
    width:           8,
    height:          8,
    borderRadius:    4,
    backgroundColor: colors.trackingDot,
  },
  spinner: {},
  errorText: {
    color:             colors.error,
    fontSize:          12,
    paddingHorizontal: 16,
    marginBottom:      6,
    lineHeight:        18,
  },

  // ── Cards ──
  card: {
    backgroundColor:  colors.surface,
    borderWidth:      1,
    borderColor:      colors.border,
    borderRadius:     14,
    marginHorizontal: 16,
    marginTop:        10,
    padding:          14,
  },
  cardLabel: {
    color:         colors.accent,
    fontSize:      11,
    fontWeight:    '500',
    letterSpacing: 1.1,
    marginBottom:  6,
    textTransform: 'uppercase',
  },

  // ── Narration card ──
  storyCard: {
    maxHeight: 160,
  },
  storyScroll: {},
  storyText: {
    color:      colors.bodyText,
    fontSize:   15,
    lineHeight: 25.5,
  },

  // ── Story log ──
  logCard: {
    paddingBottom: 6,
  },
  logEntry: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop:     8,
    marginTop:      4,
  },
  logEntryLast: {},
  logPlace: {
    color:      colors.accent,
    fontSize:   11,
    fontWeight: '600',
    marginBottom: 2,
  },
  logSnippet: {
    color:      colors.mutedText,
    fontSize:   12,
    lineHeight: 17,
  },

  // ── Controls ──
  controls: {
    paddingHorizontal: 16,
    paddingTop:        10,
    paddingBottom:     20,
    gap:               10,
    backgroundColor:   colors.bg,
  },
  controlsRow: {
    flexDirection: 'row',
    gap:           10,
  },
  muteButton: {
    backgroundColor:  colors.accentBg,
    borderRadius:     14,
    paddingVertical:   15,
    paddingHorizontal: 16,
    alignItems:       'center',
    justifyContent:   'center',
    borderWidth:      1,
    borderColor:      colors.accentDim,
  },
  mutedButton: {
    backgroundColor: colors.surface,
    borderColor:     colors.border,
  },
  muteButtonText: {
    fontSize: 16,
  },
  startButton: {
    flex:            1,
    backgroundColor: colors.startBg,
    borderRadius:    14,
    paddingVertical: 15,
    alignItems:     'center',
    justifyContent: 'center',
  },
  startButtonText: {
    color:         colors.startText,
    fontSize:      16,
    fontWeight:    '700',
    letterSpacing: 0.4,
  },
  stopButton: {
    flex:            1,
    backgroundColor: colors.stopBg,
    borderRadius:    14,
    paddingVertical: 15,
    alignItems:     'center',
    justifyContent: 'center',
  },
  stopButtonText: {
    color:         colors.stopText,
    fontSize:      16,
    fontWeight:    '700',
    letterSpacing: 0.4,
  },
  regenerateButton: {
    backgroundColor: colors.bg,
    borderWidth:     1,
    borderColor:     colors.accentDim,
    borderRadius:    14,
    paddingVertical: 13,
    alignItems:     'center',
    justifyContent: 'center',
  },
  regenerateButtonText: {
    color:      colors.accent,
    fontSize:   15,
    fontWeight: '600',
  },

  // ── Story Log Modal ──
  modalSafe: {
    flex:            1,
    backgroundColor: colors.bg,
  },
  modalHeader: {
    flexDirection:    'row',
    alignItems:       'center',
    justifyContent:   'space-between',
    paddingHorizontal: 20,
    paddingVertical:   16,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  modalTitle: {
    color:      colors.primaryText,
    fontSize:   20,
    fontWeight: '600',
  },
  modalCloseButton: {
    width:           32,
    height:          32,
    borderRadius:    16,
    backgroundColor: colors.accentBg,
    borderWidth:     1,
    borderColor:     colors.accentDim,
    alignItems:     'center',
    justifyContent: 'center',
  },
  modalCloseText: {
    color:      colors.accent,
    fontSize:   14,
    fontWeight: '600',
  },
  modalScroll: {
    flex: 1,
  },
  modalScrollContent: {
    paddingHorizontal: 20,
    paddingVertical:   16,
  },
  modalEntry: {
    marginBottom: 4,
  },
  modalEntryHeader: {
    flexDirection:  'row',
    alignItems:     'center',
    justifyContent: 'space-between',
    marginBottom:    6,
  },
  modalEntryPlace: {
    color:      colors.accent,
    fontSize:   13,
    fontWeight: '600',
    flex:       1,
  },
  modalEntryTime: {
    color:       colors.mutedText,
    fontSize:    12,
    marginLeft:  12,
    fontFamily:  Platform.OS === 'ios' ? 'Courier New' : 'monospace',
  },
  modalEntryStory: {
    color:      colors.bodyText,
    fontSize:   15,
    lineHeight: 25.5,
  },
  modalDivider: {
    height:          1,
    backgroundColor: colors.border,
    marginVertical:  20,
  },

  // ── Help Modal ──
  helpOverlay: {
    flex:            1,
    backgroundColor: 'rgba(38,33,92,0.45)',
    alignItems:     'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  helpModal: {
    backgroundColor: colors.surface,
    borderRadius:    18,
    borderWidth:     1,
    borderColor:     colors.border,
    padding:         24,
    width:           '100%',
  },
  helpTitle: {
    color:        colors.primaryText,
    fontSize:     20,
    fontWeight:   '600',
    marginBottom: 16,
  },
  helpBody: {
    color:        colors.bodyText,
    fontSize:     15,
    lineHeight:   25,
    marginBottom: 24,
  },
  helpEmphasis: {
    color:      colors.accent,
    fontWeight: '600',
  },
  helpCloseButton: {
    backgroundColor: colors.startBg,
    borderRadius:    12,
    paddingVertical: 13,
    alignItems:     'center',
  },
  helpCloseText: {
    color:      colors.startText,
    fontSize:   16,
    fontWeight: '700',
  },
});
