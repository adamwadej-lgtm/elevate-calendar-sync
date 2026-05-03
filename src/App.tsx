/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  Users,
  Calendar as CalendarIcon,
  Plus,
  X,
  CheckCircle2,
  Clock,
  ChevronRight,
  Mic,
  MicOff,
  Send,
  Copy,
  Loader2,
  Check,
  AlertCircle,
  Edit2,
  Trash2,
  PlusCircle,
  Keyboard,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, onSnapshot, collection, addDoc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';

// --- Firebase Config ---
const firebaseConfig = {
  apiKey: "AIzaSyCd0vHdlveAhLwOueSMP_A7-k6HyskDZEc",
  authDomain: "elevate-calendar-sync.firebaseapp.com",
  projectId: "elevate-calendar-sync",
  storageBucket: "elevate-calendar-sync.firebasestorage.app",
  messagingSenderId: "322023180648",
  appId: "1:322023180648:web:b6505511b20f5ede7c6edd",
  measurementId: "G-TCV1C9VE7S"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);

// --- Transcription Proxy ---
// Audio is sent to a Netlify serverless function that proxies to Deepgram server-side,
// bypassing CORS. The DEEPGRAM_API_KEY lives in Netlify environment variables.
const TRANSCRIBE_ENDPOINT = '/.netlify/functions/transcribe';
const PARSE_ENDPOINT = '/.netlify/functions/parse';

// --- Types ---
type ParsedSlot = {
  date: string;   // YYYY-MM-DD
  start: string;  // HH:mm
  end: string;    // HH:mm
  unavailable?: boolean;
};

type Participant = {
  id: string;
  name: string;
  transcript: string;
  slots: ParsedSlot[];
  submittedAt: string;
};

type MeetingGroup = {
  id: string;
  title: string;
  creatorName: string;
  creatorEmail: string;
  deadline: string;
  expectedCount: number;
  requireCode: boolean; // if true, users must enter the meeting ID to join; if false, link grants direct access
  participants: Participant[];
  archivedParticipants?: Participant[];
  createdAt: string;
  notified: boolean;
};

type SyncResult = {
  date: string;
  slots: { start: string; end: string }[];
  participantNames: string[];
  isFull: boolean;
};

type EditingSlot = {
  index: number;
  start: string;
  end: string;
};

// --- Utils ---
const generateId = () => Math.random().toString(36).substr(2, 9);

const formatTime = (time: string) => {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${h}:${minutes.toString().padStart(2, '0')} ${ampm}`;
};

const formatDate = (dateStr: string) => {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
};

const formatDateFull = (dateStr: string) => {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
};

// --- Claude AI Parser (via Netlify proxy) ---
const parseAvailabilityWithClaude = async (
  transcript: string,
  referenceDate: string,
  existingSlots: ParsedSlot[] = []
): Promise<{ slots: ParsedSlot[]; warnings: string[] }> => {
  const response = await fetch(PARSE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      transcript,
      referenceDate,
      existingSlots,
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.error('Parse proxy error:', response.status, errorBody);
    throw new Error(`Schedule parsing failed (${response.status})`);
  }

  const data = await response.json();
  const text = data.content?.[0]?.text || '{}';
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    // Handle both old format (array) and new format (object with slots/warnings)
    if (Array.isArray(parsed)) {
      return { slots: parsed, warnings: [] };
    }
    return {
      slots: parsed.slots || [],
      warnings: parsed.warnings || [],
    };
  } catch {
    return { slots: existingSlots, warnings: [] };
  }
};

// --- Sync Calculator ---
const timeToMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const minToTime = (m: number) => { const h = Math.floor(m / 60); const min = m % 60; return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`; };

const findOverlap = (allSlots: ParsedSlot[][]): { start: string; end: string }[] => {
  if (allSlots.length === 0) return [];
  if (allSlots.length === 1) return allSlots[0].filter(s => !s.unavailable).map(s => ({ start: s.start, end: s.end }));
  let common = allSlots[0].filter(s => !s.unavailable).map(s => ({ start: s.start, end: s.end }));
  for (let i = 1; i < allSlots.length; i++) {
    const next: { start: string; end: string }[] = [];
    for (const a of common) {
      for (const b of allSlots[i].filter(s => !s.unavailable)) {
        const start = Math.max(timeToMin(a.start), timeToMin(b.start));
        const end = Math.min(timeToMin(a.end), timeToMin(b.end));
        if (start < end) next.push({ start: minToTime(start), end: minToTime(end) });
      }
    }
    common = next;
    if (common.length === 0) break;
  }
  return common;
};

const calculateSync = (participants: Participant[]): SyncResult[] => {
  if (participants.length === 0) return [];
  const dateMap: Record<string, { participantId: string; name: string; slots: ParsedSlot[] }[]> = {};
  participants.forEach(p => {
    p.slots.filter(s => !s.unavailable).forEach(slot => {
      if (!dateMap[slot.date]) dateMap[slot.date] = [];
      const existing = dateMap[slot.date].find(x => x.participantId === p.id);
      if (existing) existing.slots.push(slot);
      else dateMap[slot.date].push({ participantId: p.id, name: p.name, slots: [slot] });
    });
  });
  const results: SyncResult[] = [];
  Object.entries(dateMap).forEach(([date, participantSlots]) => {
    const overlap = findOverlap(participantSlots.map(ps => ps.slots));
    if (overlap.length > 0) {
      results.push({ date, slots: overlap, participantNames: participantSlots.map(ps => ps.name), isFull: participantSlots.length === participants.length });
    }
  });
  return results.sort((a, b) => a.date.localeCompare(b.date));
};

// --- Main App ---
export default function App() {
  const [view, setView] = useState<'home' | 'create' | 'submit' | 'results'>('home');
  const [meetingGroups, setMeetingGroups] = useState<MeetingGroup[]>([]);
  const [activeMeeting, setActiveMeeting] = useState<MeetingGroup | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState('');
  const [hasMic, setHasMic] = useState<boolean | null>(null);
  const [copiedId, setCopiedId] = useState('');
  const [editingTitle, setEditingTitle] = useState(false);
  const [editTitleValue, setEditTitleValue] = useState('');
  const [viewingParticipant, setViewingParticipant] = useState<Participant | null>(null);
  const [expandedParticipantId, setExpandedParticipantId] = useState<string | null>(null);

  // Create form
  const [createForm, setCreateForm] = useState({ title: '', creatorName: '', creatorEmail: '', deadline: '', expectedCount: 4, requireCode: false });

  // Submit flow
  const [submitStep, setSubmitStep] = useState<'input' | 'review' | 'editing' | 'done'>('input');
  const [participantName, setParticipantName] = useState('');
  const [transcript, setTranscript] = useState('');
  const [textInput, setTextInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isParsing, setIsParsing] = useState(false);
  const [parsedSlots, setParsedSlots] = useState<ParsedSlot[]>([]);
  const [parseWarnings, setParseWarnings] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState('');
  const [recordingSecondsLeft, setRecordingSecondsLeft] = useState(60);

  // Edit flow
  const [editingSlot, setEditingSlot] = useState<EditingSlot | null>(null);
  const [isEditRecording, setIsEditRecording] = useState(false);
  const [editTranscript, setEditTranscript] = useState('');
  const [editTextInput, setEditTextInput] = useState('');
  const [isEditParsing, setIsEditParsing] = useState(false);
  const [longPressTimer, setLongPressTimer] = useState<any>(null);

  const recognitionRef = useRef<any>(null);
  const editRecognitionRef = useRef<any>(null);
  const finalTranscriptRef = useRef<string>('');
  const silenceTimerRef = useRef<any>(null);
  const maxTimerRef = useRef<any>(null);
  const countdownRef = useRef<any>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const [audioLevel, setAudioLevel] = useState(0); // 0-1 for mic visualizer

  // Check mic availability
  useEffect(() => {
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(() => setHasMic(true))
      .catch(() => setHasMic(false));
  }, []);

  // Firebase listener
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'meetingGroups'), (snap) => {
      const groups: MeetingGroup[] = [];
      snap.forEach(d => groups.push({ id: d.id, ...d.data() } as MeetingGroup));
      setMeetingGroups(groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setIsLoading(false);
    });
    return () => unsub();
  }, []);

  // Check URL join code
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join');
    if (code) handleJoinMeeting(code, true);
  }, []);

  // Sync active meeting
  useEffect(() => {
    if (activeMeeting) {
      const updated = meetingGroups.find(g => g.id === activeMeeting.id);
      if (updated) setActiveMeeting(updated);
    }
  }, [meetingGroups]);

  const handleCreateMeeting = async () => {
    if (!createForm.title || !createForm.creatorName || !createForm.creatorEmail || !createForm.deadline) return;
    const newMeeting = { ...createForm, participants: [], archivedParticipants: [], createdAt: new Date().toISOString(), notified: false };
    const docRef = await addDoc(collection(db, 'meetingGroups'), newMeeting);
    setActiveMeeting({ ...newMeeting, id: docRef.id });
    setView('results');
    setCreateForm({ title: '', creatorName: '', creatorEmail: '', deadline: '', expectedCount: 4, requireCode: false });
  };

  const handleJoinMeeting = async (code: string, fromLink = false) => {
    const id = code.trim();
    const docSnap = await getDoc(doc(db, 'meetingGroups', id));
    if (docSnap.exists()) {
      const meeting = { id: docSnap.id, ...docSnap.data() } as MeetingGroup;
      // If requireCode is on AND this came from a link (not manual code entry), show the results page instead of submit
      if (meeting.requireCode && fromLink) {
        setActiveMeeting(meeting);
        setView('results');
        setJoinError('');
      } else {
        setActiveMeeting(meeting);
        setView('submit');
        setJoinError('');
      }
    } else {
      setJoinError('Meeting not found. Check the link and try again.');
    }
  };

  // --- Main recording using Deepgram (works on all devices) ---
  const mediaRecorderRef = useRef<any>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const stopAllTimers = () => {
    if (maxTimerRef.current) { clearTimeout(maxTimerRef.current); maxTimerRef.current = null; }
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null; }
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
    silenceStartRef.current = null;
    setAudioLevel(0);
  };

  const stopRecording = useCallback(() => {
    stopAllTimers();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    setIsRecording(false);
    setRecordingSecondsLeft(60);
  }, []);

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setSubmitError('Microphone not supported on this device.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      setSubmitError('');
      setRecordingSecondsLeft(60);
      silenceStartRef.current = null;

      // --- Audio analyser for silence detection + voice visualizer ---
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.3;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.fftSize);
      const SILENCE_THRESHOLD = 15; // RMS below this = silence
      const SILENCE_DURATION_MS = 4000; // 4s of silence to auto-stop
      const stopRecordingRef = { stopped: false };

      const monitorAudio = () => {
        if (stopRecordingRef.stopped) return;
        analyser.getByteTimeDomainData(dataArray);

        // Calculate RMS volume
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          const v = (dataArray[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / dataArray.length);
        const level = Math.min(1, rms * 4); // scale up for visual effect
        setAudioLevel(level);

        // Silence detection
        const rmsScaled = rms * 128;
        if (rmsScaled < SILENCE_THRESHOLD) {
          if (!silenceStartRef.current) {
            silenceStartRef.current = Date.now();
          } else if (Date.now() - silenceStartRef.current > SILENCE_DURATION_MS) {
            stopRecordingRef.stopped = true;
            stopRecording();
            audioCtx.close();
            return;
          }
        } else {
          silenceStartRef.current = null;
        }

        animFrameRef.current = requestAnimationFrame(monitorAudio);
      };
      animFrameRef.current = requestAnimationFrame(monitorAudio);

      // Pick best supported format
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
        ? 'audio/mp4'
        : '';

      const mediaRecorder = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e: any) => {
        if (e.data && e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stopRecordingRef.stopped = true;
        if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null; }
        setAudioLevel(0);
        try { audioCtx.close(); } catch {}
        stream.getTracks().forEach(t => t.stop());
        if (audioChunksRef.current.length === 0) {
          setSubmitError('No audio captured. Please try again.');
          setIsParsing(false);
          return;
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
        setIsParsing(true);

        // Step 1: Convert audio to base64
        let transcribedText = '';
        try {
          const arrayBuffer = await audioBlob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < uint8.length; i++) {
            binary += String.fromCharCode(uint8[i]);
          }
          const base64Audio = btoa(binary);

          // Step 2: Send to Deepgram via Netlify proxy
          const dgResponse = await fetch(
            TRANSCRIBE_ENDPOINT,
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                audio: base64Audio,
                mimeType: mediaRecorder.mimeType || 'audio/webm',
              }),
            }
          );

          if (!dgResponse.ok) {
            const errorBody = await dgResponse.text().catch(() => '');
            console.error('Transcription proxy error:', dgResponse.status, errorBody);
            setSubmitError(`Transcription failed (${dgResponse.status}). ${errorBody.slice(0, 100)}`);
            setIsParsing(false);
            return;
          }

          const dgData = await dgResponse.json();
          transcribedText = dgData?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';

          if (!transcribedText.trim()) {
            setSubmitError('No speech detected. Please speak clearly and try again.');
            setIsParsing(false);
            return;
          }
        } catch (e: any) {
          console.error('Deepgram transcription error:', e);
          setSubmitError(`Transcription error: ${e.message || 'Unknown error'}`);
          setIsParsing(false);
          return;
        }

        // Step 3: Parse with Claude to extract schedule
        try {
          const combined = finalTranscriptRef.current
            ? finalTranscriptRef.current + ' ' + transcribedText
            : transcribedText;
          finalTranscriptRef.current = combined;
          setTranscript(combined);

          const today = new Date().toISOString().split('T')[0];
          const result = await parseAvailabilityWithClaude(combined, today, parsedSlots);
          setParsedSlots(result.slots);
          setParseWarnings(result.warnings);
          setIsParsing(false);

        } catch (e: any) {
          console.error('Claude parsing error:', e);
          setSubmitError(`Schedule parsing failed: ${e.message || 'Unknown error'}. Your voice was captured — try tapping Process My Schedule.`);
          setIsParsing(false);
        }
      };

      mediaRecorder.start(250);
      setIsRecording(true);

      // Countdown
      let secondsLeft = 60;
      countdownRef.current = setInterval(() => {
        secondsLeft -= 1;
        setRecordingSecondsLeft(secondsLeft);
        if (secondsLeft <= 0) stopRecording();
      }, 1000);

      maxTimerRef.current = setTimeout(() => stopRecording(), 60000);

    } catch (e: any) {
      if (e.name === 'NotAllowedError') {
        setSubmitError('Microphone access denied. Please allow microphone access in your browser settings.');
      } else {
        setSubmitError('Could not start recording. Please try again.');
      }
    }
  };

  const handleProcessInput = async () => {
    if (!hasMic) {
      const input = textInput.trim();
      if (!input || !participantName.trim()) { setSubmitError('Please enter your name and availability.'); return; }
      setIsParsing(true);
      setSubmitError('');
      try {
        const today = new Date().toISOString().split('T')[0];
        const result = await parseAvailabilityWithClaude(input, today);
        setParsedSlots(result.slots);
        setParseWarnings(result.warnings);
        setSubmitStep('review');
      } catch (e: any) {
        console.error('Text parse error:', e);
        setSubmitError(`Could not parse schedule: ${e.message || 'Unknown error'}`);
      }
      setIsParsing(false);
      return;
    }
    if (!finalTranscriptRef.current.trim() && parsedSlots.length === 0) {
      setSubmitError('Please record your availability first.');
      return;
    }
    if (!participantName.trim()) { setSubmitError('Please enter your name.'); return; }
    setSubmitStep('review');
  };

  // --- Edit recording using Deepgram ---
  const startEditRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const mr = new MediaRecorder(stream, { mimeType });
      mr.ondataavailable = (e: any) => { if (e.data.size > 0) chunks.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: mimeType });
        try {
          const arrayBuffer = await blob.arrayBuffer();
          const uint8 = new Uint8Array(arrayBuffer);
          let binary = '';
          for (let i = 0; i < uint8.length; i++) {
            binary += String.fromCharCode(uint8[i]);
          }
          const base64Audio = btoa(binary);

          const res = await fetch(TRANSCRIBE_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ audio: base64Audio, mimeType }),
          });
          const data = await res.json();
          const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || '';
          setEditTranscript(text);
        } catch { setEditTranscript(''); }
        setIsEditRecording(false);
      };
      mr.start(250);
      setIsEditRecording(true);
      editRecognitionRef.current = mr;
    } catch { setIsEditRecording(false); }
  };

  const stopEditRecording = () => {
    if (editRecognitionRef.current && editRecognitionRef.current.state !== 'inactive') {
      try { editRecognitionRef.current.stop(); } catch {}
    }
    setIsEditRecording(false);
  };

  const handleApplyEdit = async () => {
    const input = hasMic ? editTranscript : editTextInput;
    if (!input.trim()) return;
    setIsEditParsing(true);
    const today = new Date().toISOString().split('T')[0];
    const result = await parseAvailabilityWithClaude(input, today, parsedSlots);
    setParsedSlots(result.slots);
    setParseWarnings(result.warnings);
    setSubmitStep('review');
    setEditTranscript('');
    setEditTextInput('');
    setEditingSlot(null);
    setIsEditParsing(false);
  };

  // Long press / right click to edit individual slot time
  const handleLongPressStart = (index: number, slot: ParsedSlot) => {
    const timer = setTimeout(() => {
      setEditingSlot({ index, start: slot.start, end: slot.end });
      setSubmitStep('editing');
    }, 600);
    setLongPressTimer(timer);
  };

  const handleLongPressEnd = () => {
    if (longPressTimer) { clearTimeout(longPressTimer); setLongPressTimer(null); }
  };

  const handleRightClick = (e: React.MouseEvent, index: number, slot: ParsedSlot) => {
    e.preventDefault();
    setEditingSlot({ index, start: slot.start, end: slot.end });
    setSubmitStep('editing');
  };

  const handleSaveSlotEdit = () => {
    if (!editingSlot) return;
    const updated = [...parsedSlots];
    updated[editingSlot.index] = { ...updated[editingSlot.index], start: editingSlot.start, end: editingSlot.end };
    setParsedSlots(updated);
    setEditingSlot(null);
    setSubmitStep('review');
  };

  const handleRemoveSlot = (index: number) => {
    setParsedSlots(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmitAvailability = async () => {
    if (!activeMeeting) return;
    if (!participantName.trim()) {
      setSubmitError('Name is required to submit.');
      return;
    }
    try {
      const participant: Participant = {
        id: generateId(),
        name: participantName.trim(),
        transcript: hasMic ? transcript : textInput,
        slots: parsedSlots,
        submittedAt: new Date().toISOString()
      };
      const existingParticipants = activeMeeting.participants || [];
      const existingIndex = existingParticipants.findIndex(
        p => p.name.toLowerCase() === participantName.trim().toLowerCase()
      );
      let updatedParticipants: Participant[];
      if (existingIndex >= 0) {
        updatedParticipants = [...existingParticipants];
        updatedParticipants[existingIndex] = participant;
      } else {
        updatedParticipants = [...existingParticipants, participant];
      }
      await updateDoc(doc(db, 'meetingGroups', activeMeeting.id), { participants: updatedParticipants });
      setSubmitStep('done');
      setParticipantName('');
      setTranscript('');
      setTextInput('');
      setParsedSlots([]);
    } catch (e: any) {
      console.error('Submit error:', e);
      setSubmitError(`Could not submit schedule: ${e.message || 'Unknown error'}`);
    }
  };

  const copyJoinLink = (meetingId: string) => {
    const url = `${window.location.origin}${window.location.pathname}?join=${meetingId}`;
    navigator.clipboard.writeText(url);
    setCopiedId(meetingId);
    setTimeout(() => setCopiedId(''), 2000);
  };

  const handleDeleteMeeting = async (meetingId: string) => {
    await deleteDoc(doc(db, 'meetingGroups', meetingId));
    if (activeMeeting?.id === meetingId) {
      setActiveMeeting(null);
      setView('home');
    }
  };

  const handleUpdateTitle = async () => {
    if (!activeMeeting || !editTitleValue.trim()) return;
    await updateDoc(doc(db, 'meetingGroups', activeMeeting.id), { title: editTitleValue.trim() });
    setEditingTitle(false);
  };

  const handleRemoveParticipant = async (participantId: string) => {
    if (!activeMeeting) return;
    const participant = activeMeeting.participants.find(p => p.id === participantId);
    if (!participant) return;
    const updatedParticipants = activeMeeting.participants.filter(p => p.id !== participantId);
    const archived = [...(activeMeeting.archivedParticipants || []), participant];
    await updateDoc(doc(db, 'meetingGroups', activeMeeting.id), {
      participants: updatedParticipants,
      archivedParticipants: archived,
    });
  };

  const handleRestoreParticipant = async (participantId: string) => {
    if (!activeMeeting) return;
    const archived = activeMeeting.archivedParticipants || [];
    const participant = archived.find(p => p.id === participantId);
    if (!participant) return;
    const updatedArchived = archived.filter(p => p.id !== participantId);
    const updatedParticipants = [...activeMeeting.participants, participant];
    await updateDoc(doc(db, 'meetingGroups', activeMeeting.id), {
      participants: updatedParticipants,
      archivedParticipants: updatedArchived,
    });
  };

  const resetSubmit = () => {
    stopAllTimers();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stop(); } catch {}
    }
    mediaRecorderRef.current = null;
    audioChunksRef.current = [];
    finalTranscriptRef.current = '';
    setIsRecording(false);
    setIsParsing(false);
    setRecordingSecondsLeft(60);
    setSubmitStep('input');
    setTranscript('');
    setTextInput('');
    setParsedSlots([]);
    setParseWarnings([]);
    setEditTranscript('');
    setEditTextInput('');
    setEditingSlot(null);
    setSubmitError('');
  };

  const syncResults = useMemo(() => {
    if (!activeMeeting) return [];
    return calculateSync(activeMeeting.participants || []);
  }, [activeMeeting]);

  const fullMatches = syncResults.filter(r => r.isFull);
  const partialMatches = syncResults.filter(r => !r.isFull);

  // Group slots for display
  const availableSlots = parsedSlots.filter(s => !s.unavailable);
  const unavailableSlots = parsedSlots.filter(s => s.unavailable);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-950 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-orange-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-white font-bold">Loading Elevate Voice Sync...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white font-sans">
      {/* Header */}
      <header className="border-b border-white/10 px-6 py-4">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => { setView('home'); setActiveMeeting(null); resetSubmit(); }}>
            <div className="bg-orange-500 p-2 rounded-xl"><Mic className="w-5 h-5 text-white" /></div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">Elevate Voice Sync</h1>
              <p className="text-[10px] text-white/40 uppercase tracking-widest">Speak your availability</p>
            </div>
          </div>
          {view === 'home' && (
            <button onClick={() => setView('create')} className="bg-orange-500 text-white px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-orange-600 transition-all">
              <Plus className="w-4 h-4" />New Meeting Group
            </button>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <AnimatePresence mode="wait">

          {/* HOME */}
          {view === 'home' && (
            <motion.div key="home" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-8">
              <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
                <h2 className="font-bold text-white mb-1">Join a Meeting Group</h2>
                <p className="text-white/50 text-sm mb-4">Paste a meeting ID or full link to submit your availability.</p>
                <div className="flex gap-3">
                  <input type="text" placeholder="Paste meeting ID or full link..." className="flex-1 bg-white/10 border border-white/10 rounded-xl px-4 py-2 text-sm text-white placeholder-white/30 outline-none focus:border-orange-500" value={joinCode} onChange={e => { const val = e.target.value; const match = val.match(/[?&]join=([^&]+)/); setJoinCode(match ? match[1] : val); }} />
                  <button onClick={() => handleJoinMeeting(joinCode)} className="bg-orange-500 text-white px-4 py-2 rounded-xl font-bold text-sm hover:bg-orange-600 transition-all">Join</button>
                </div>
                {joinError && <p className="text-red-400 text-xs mt-2">{joinError}</p>}
              </div>

              <div>
                <h2 className="font-bold text-white mb-4">Your Meeting Groups</h2>
                {meetingGroups.length === 0 ? (
                  <div className="text-center py-20 bg-white/5 rounded-3xl border border-dashed border-white/10">
                    <CalendarIcon className="w-12 h-12 text-white/20 mx-auto mb-4" />
                    <p className="text-white/40 font-medium">No meeting groups yet.</p>
                    <p className="text-white/30 text-sm">Create one to get started.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {meetingGroups.map(group => {
                      const submitted = group.participants?.length || 0;
                      const total = group.expectedCount;
                      const pct = Math.round((submitted / total) * 100);
                      return (
                        <motion.div key={group.id} whileHover={{ y: -2 }} className="bg-white/5 border border-white/10 rounded-2xl p-5 cursor-pointer hover:border-orange-500/40 transition-all relative group">
                          <div onClick={() => { setActiveMeeting(group); setView('results'); }}>
                            <div className="flex justify-between items-start mb-3">
                              <div>
                                <h3 className="font-bold text-white">{group.title}</h3>
                                <p className="text-white/40 text-xs">by {group.creatorName}</p>
                              </div>
                              <div className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${submitted >= total ? 'bg-green-500/20 text-green-400' : 'bg-orange-500/20 text-orange-400'}`}>
                                {submitted >= total ? 'Complete' : 'Pending'}
                              </div>
                            </div>
                            <div className="space-y-1">
                              <div className="flex justify-between text-xs text-white/40">
                                <span>{submitted} of {total} submitted</span>
                                <span>Due {formatDate(group.deadline)}</span>
                              </div>
                              <div className="w-full bg-white/10 rounded-full h-1.5">
                                <div className="bg-orange-500 h-1.5 rounded-full transition-all" style={{ width: `${pct}%` }}></div>
                              </div>
                            </div>
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); if (window.confirm(`Delete "${group.title}"? This cannot be undone.`)) handleDeleteMeeting(group.id); }}
                            className="absolute top-3 right-3 p-1.5 rounded-lg text-white/20 hover:text-red-400 hover:bg-red-500/10 transition-all opacity-0 group-hover:opacity-100"
                            title="Delete meeting group"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </motion.div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* CREATE */}
          {view === 'create' && (
            <motion.div key="create" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-xl mx-auto">
              <div className="flex items-center gap-3 mb-8">
                <button onClick={() => setView('home')} className="p-2 hover:bg-white/10 rounded-xl transition-all"><ChevronRight className="w-5 h-5 rotate-180" /></button>
                <div>
                  <h2 className="text-2xl font-bold">Create Meeting Group</h2>
                  <p className="text-white/40 text-sm">Set up your group then share the join link</p>
                </div>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Meeting Title</label>
                  <input type="text" placeholder="e.g. June Planning Sessions" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white placeholder-white/20 outline-none focus:border-orange-500" value={createForm.title} onChange={e => setCreateForm({ ...createForm, title: e.target.value })} />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Your Name</label>
                    <input type="text" placeholder="Adam" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white placeholder-white/20 outline-none focus:border-orange-500" value={createForm.creatorName} onChange={e => setCreateForm({ ...createForm, creatorName: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Your Email</label>
                    <input type="email" placeholder="adam@elevate.org" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white placeholder-white/20 outline-none focus:border-orange-500" value={createForm.creatorEmail} onChange={e => setCreateForm({ ...createForm, creatorEmail: e.target.value })} />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Submission Deadline</label>
                    <input type="date" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white outline-none focus:border-orange-500" value={createForm.deadline} onChange={e => setCreateForm({ ...createForm, deadline: e.target.value })} />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Expected Participants</label>
                    <select className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white outline-none focus:border-orange-500 appearance-none" value={createForm.expectedCount} onChange={e => setCreateForm({ ...createForm, expectedCount: parseInt(e.target.value) })}>
                      {[2,3,4,5,6,7,8,10,12,15,20].map(n => <option key={n} value={n}>{n} people</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-bold text-white">Require Join Code</p>
                    <p className="text-[11px] text-white/40">When on, participants must enter the meeting ID to join. When off, anyone with the link can join directly.</p>
                  </div>
                  <button
                    onClick={() => setCreateForm({ ...createForm, requireCode: !createForm.requireCode })}
                    className={`relative w-12 h-6 rounded-full transition-all ${createForm.requireCode ? 'bg-orange-500' : 'bg-white/20'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all shadow ${createForm.requireCode ? 'left-6' : 'left-0.5'}`} />
                  </button>
                </div>
                <button disabled={!createForm.title || !createForm.creatorName || !createForm.creatorEmail || !createForm.deadline} onClick={handleCreateMeeting} className="w-full bg-orange-500 text-white py-3 rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-40 flex items-center justify-center gap-2">
                  <Plus className="w-5 h-5" />Create & Get Shareable Link
                </button>
              </div>
            </motion.div>
          )}

          {/* SUBMIT */}
          {view === 'submit' && activeMeeting && (
            <motion.div key="submit" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="max-w-xl mx-auto">
              <div className="text-center mb-8">
                <div className="inline-flex items-center gap-2 bg-orange-500/20 text-orange-400 px-4 py-2 rounded-full text-sm font-bold mb-4">
                  <CalendarIcon className="w-4 h-4" />{activeMeeting.title}
                </div>
                <h2 className="text-3xl font-bold mb-2">
                  {submitStep === 'input' && (hasMic ? 'Speak Your Availability' : 'Type Your Availability')}
                  {submitStep === 'review' && 'Review Your Schedule'}
                  {submitStep === 'editing' && (editingSlot !== null ? 'Edit Time' : 'Make a Correction')}
                  {submitStep === 'done' && "You're Submitted!"}
                </h2>
                <p className="text-white/40 text-sm">
                  {submitStep === 'input' && (hasMic ? 'Hit record and speak naturally. Be specific about dates and times.' : 'Type your availability below. Be specific about dates and times.')}
                  {submitStep === 'review' && 'Does this look right? Submit or make corrections below.'}
                  {submitStep === 'editing' && (editingSlot !== null ? 'Adjust the time. The date cannot be changed here.' : 'Speak or type your correction and we\'ll update your schedule.')}
                </p>
              </div>

              <AnimatePresence mode="wait">

                {/* INPUT STEP */}
                {submitStep === 'input' && (
                  <motion.div key="input" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">
                    <div className="space-y-2">
                      <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Your Name</label>
                      <input type="text" placeholder="e.g. Mandy" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white placeholder-white/20 outline-none focus:border-orange-500" value={participantName} onChange={e => setParticipantName(e.target.value)} />
                    </div>

                    {/* Example */}
                    <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                      <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Example</p>
                      <p className="text-white/50 text-sm italic">"I'm available every Monday in June from 9am to 2pm. Also free June 4th, 5th, and 6th from 11am to 4pm. Not available June 8th. Available 2pm to 6pm every Saturday and Sunday in July, except July 4th."</p>
                    </div>

                    {hasMic ? (
                      <>
                        <div className="flex flex-col items-center gap-4">
                          {/* Countdown ring + voice pulse around record button */}
                          <div className="relative w-40 h-40 flex items-center justify-center">
                            {isRecording && (
                              <>
                                {/* Outer voice pulse ring */}
                                <div
                                  className="absolute rounded-full border-2 border-orange-500/40 transition-all duration-75"
                                  style={{
                                    width: `${128 + audioLevel * 40}px`,
                                    height: `${128 + audioLevel * 40}px`,
                                    opacity: 0.2 + audioLevel * 0.6,
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                  }}
                                />
                                {/* Middle voice pulse ring */}
                                <div
                                  className="absolute rounded-full transition-all duration-100"
                                  style={{
                                    width: `${112 + audioLevel * 24}px`,
                                    height: `${112 + audioLevel * 24}px`,
                                    background: `radial-gradient(circle, rgba(249,115,22,${0.08 + audioLevel * 0.15}) 0%, transparent 70%)`,
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                  }}
                                />
                                {/* Countdown SVG ring */}
                                <svg className="absolute w-32 h-32" style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%) rotate(-90deg)' }} viewBox="0 0 128 128">
                                  <circle cx="64" cy="64" r="58" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="4" />
                                  <circle
                                    cx="64" cy="64" r="58" fill="none"
                                    stroke={recordingSecondsLeft > 15 ? '#f97316' : '#ef4444'}
                                    strokeWidth="4"
                                    strokeLinecap="round"
                                    strokeDasharray={`${2 * Math.PI * 58}`}
                                    strokeDashoffset={`${2 * Math.PI * 58 * (1 - recordingSecondsLeft / 60)}`}
                                    style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
                                  />
                                </svg>
                              </>
                            )}
                            <motion.button
                              whileTap={{ scale: 0.95 }}
                              onClick={isRecording ? stopRecording : startRecording}
                              className={`relative z-10 w-24 h-24 rounded-full flex flex-col items-center justify-center text-white shadow-lg transition-all gap-1 ${isRecording ? 'bg-red-500' : 'bg-orange-500 hover:bg-orange-600'}`}
                              style={isRecording ? {
                                boxShadow: `0 0 ${10 + audioLevel * 25}px ${audioLevel * 12}px rgba(239,68,68,${0.3 + audioLevel * 0.4})`,
                                transition: 'box-shadow 0.08s ease-out',
                              } : undefined}
                            >
                              {isRecording
                                ? <><MicOff className="w-9 h-9" /><span className="text-[11px] font-bold">{recordingSecondsLeft}s</span></>
                                : <><Mic className="w-9 h-9" /><span className="text-[11px] font-bold">Record</span></>
                              }
                            </motion.button>
                          </div>

                          {isRecording ? (
                            <div className="flex flex-col items-center gap-2">
                              {/* Voice level bar */}
                              <div className="flex items-center gap-1 h-4">
                                {[...Array(16)].map((_, i) => (
                                  <div
                                    key={i}
                                    className="w-1 rounded-full transition-all duration-75"
                                    style={{
                                      height: `${4 + (audioLevel > (i / 16) ? (audioLevel - i / 16) * 40 : 0)}px`,
                                      backgroundColor: audioLevel > (i / 16)
                                        ? (i > 12 ? '#ef4444' : i > 8 ? '#f97316' : '#22c55e')
                                        : 'rgba(255,255,255,0.15)',
                                    }}
                                  />
                                ))}
                              </div>
                              <div className="flex items-center gap-2 text-red-400 text-sm font-bold">
                                <div className="w-2 h-2 rounded-full bg-red-400 animate-pulse"></div>
                                {audioLevel > 0.05 ? 'Listening...' : 'Waiting for speech...'}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-xl p-3 text-blue-400 text-xs">
                          <Keyboard className="w-4 h-4 shrink-0" />
                          No microphone detected — type your availability below instead.
                        </div>
                        <textarea
                          rows={5}
                          placeholder="I'm available every Monday in June from 9am to 2pm. Not available June 8th..."
                          className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 outline-none focus:border-orange-500 text-sm leading-relaxed resize-none"
                          value={textInput}
                          onChange={e => setTextInput(e.target.value)}
                        />
                      </div>
                    )}

                    {submitError && (
                      <div className="flex items-center gap-2 text-red-400 text-sm bg-red-500/10 rounded-xl p-3">
                        <AlertCircle className="w-4 h-4 shrink-0" />{submitError}
                      </div>
                    )}

                    <button
                      disabled={(!finalTranscriptRef.current && parsedSlots.length === 0 && !textInput) || !participantName || isParsing || isRecording}
                      onClick={handleProcessInput}
                      className="w-full bg-orange-500 text-white py-3 rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                    >
                      {isParsing
                        ? <><Loader2 className="w-5 h-5 animate-spin" />Transcribing & analyzing...</>
                        : parsedSlots.length > 0
                        ? <><Send className="w-5 h-5" />Review My Schedule ({parsedSlots.length} slots found)</>
                        : <><Send className="w-5 h-5" />Process My Schedule</>
                      }
                    </button>
                  </motion.div>
                )}

                {/* REVIEW STEP */}
                {submitStep === 'review' && (
                  <motion.div key="review" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">

                    {/* Day/date warnings */}
                    {parseWarnings.length > 0 && (
                      <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-2xl p-4 space-y-2">
                        <div className="flex items-center gap-2">
                          <AlertCircle className="w-4 h-4 text-yellow-400 shrink-0" />
                          <p className="text-xs font-bold text-yellow-400 uppercase tracking-widest">Heads Up</p>
                        </div>
                        {parseWarnings.map((w, i) => (
                          <p key={i} className="text-yellow-300/80 text-sm">{w}</p>
                        ))}
                      </div>
                    )}

                    {/* Available dates */}
                    {availableSlots.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-green-400"></div>
                          <p className="text-xs font-bold text-white/40 uppercase tracking-widest">You Are Available</p>
                        </div>
                        <div className="space-y-2">
                          {availableSlots.map((slot, i) => {
                            const originalIndex = parsedSlots.indexOf(slot);
                            return (
                              <motion.div
                                key={i}
                                whileHover={{ scale: 1.01 }}
                                onMouseDown={() => handleLongPressStart(originalIndex, slot)}
                                onMouseUp={handleLongPressEnd}
                                onMouseLeave={handleLongPressEnd}
                                onTouchStart={() => handleLongPressStart(originalIndex, slot)}
                                onTouchEnd={handleLongPressEnd}
                                onContextMenu={(e) => handleRightClick(e, originalIndex, slot)}
                                className="flex items-center justify-between bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-3 cursor-pointer group select-none"
                                title="Long press (mobile) or right-click (desktop) to edit time"
                              >
                                <div>
                                  <p className="font-bold text-white text-sm">{formatDateFull(slot.date)}</p>
                                  <p className="text-green-400 font-bold text-sm">{formatTime(slot.start)} – {formatTime(slot.end)}</p>
                                </div>
                                <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button onClick={() => { setEditingSlot({ index: originalIndex, start: slot.start, end: slot.end }); setSubmitStep('editing'); }} className="p-1.5 hover:bg-white/10 rounded-lg transition-all" title="Edit time">
                                    <Edit2 className="w-3.5 h-3.5 text-white/50" />
                                  </button>
                                  <button onClick={() => handleRemoveSlot(originalIndex)} className="p-1.5 hover:bg-red-500/20 rounded-lg transition-all" title="Remove">
                                    <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                  </button>
                                </div>
                              </motion.div>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-white/20 text-center">Long press (mobile) or right-click (desktop) a date to edit its time</p>
                      </div>
                    )}

                    {/* Unavailable dates */}
                    {unavailableSlots.length > 0 && (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 rounded-full bg-red-400"></div>
                          <p className="text-xs font-bold text-white/40 uppercase tracking-widest">You Are NOT Available</p>
                        </div>
                        <div className="space-y-2">
                          {unavailableSlots.map((slot, i) => {
                            const originalIndex = parsedSlots.indexOf(slot);
                            return (
                              <div key={i} className="flex items-center justify-between bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 group">
                                <p className="font-bold text-white/60 text-sm line-through">{formatDateFull(slot.date)}</p>
                                <button onClick={() => handleRemoveSlot(originalIndex)} className="p-1.5 hover:bg-red-500/20 rounded-lg transition-all opacity-0 group-hover:opacity-100">
                                  <Trash2 className="w-3.5 h-3.5 text-red-400" />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {parsedSlots.length === 0 && (
                      <div className="text-center py-8 bg-white/5 rounded-2xl border border-dashed border-white/10">
                        <p className="text-red-400 text-sm">Nothing was parsed. Try re-recording with clearer dates and times.</p>
                      </div>
                    )}

                    {/* Action buttons */}
                    <div className="space-y-3">
                      <button
                        onClick={() => { setSubmitStep('editing'); setEditingSlot(null); setEditTranscript(''); setEditTextInput(''); }}
                        className="w-full py-3 rounded-xl font-bold text-white border border-white/10 hover:bg-white/10 transition-all flex items-center justify-center gap-2"
                      >
                        <Edit2 className="w-4 h-4" />Make a Correction
                      </button>
                      <div className="grid grid-cols-2 gap-3">
                        <button onClick={resetSubmit} className="py-3 rounded-xl font-bold text-white/40 hover:bg-white/10 transition-all border border-white/10">
                          Start Over
                        </button>
                        <button
                          disabled={parsedSlots.length === 0}
                          onClick={handleSubmitAvailability}
                          className="bg-orange-500 text-white py-3 rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                        >
                          <Check className="w-5 h-5" />Submit Schedule
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}

                {/* EDITING STEP */}
                {submitStep === 'editing' && (
                  <motion.div key="editing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="space-y-6">

                    {editingSlot !== null ? (
                      // Inline time editor for a specific slot
                      <div className="bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
                        <div className="text-center">
                          <p className="text-white/40 text-sm mb-1">Editing time for</p>
                          <p className="font-bold text-white text-lg">{formatDateFull(parsedSlots[editingSlot.index]?.date)}</p>
                          <p className="text-white/30 text-xs mt-1">Date cannot be changed here — use corrections to add/remove dates</p>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label className="text-xs font-bold uppercase text-white/40 tracking-wider">Start Time</label>
                            <input type="time" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white outline-none focus:border-orange-500" value={editingSlot.start} onChange={e => setEditingSlot({ ...editingSlot, start: e.target.value })} />
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-bold uppercase text-white/40 tracking-wider">End Time</label>
                            <input type="time" className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 font-bold text-white outline-none focus:border-orange-500" value={editingSlot.end} onChange={e => setEditingSlot({ ...editingSlot, end: e.target.value })} />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-3">
                          <button onClick={() => { setEditingSlot(null); setSubmitStep('review'); }} className="py-3 rounded-xl font-bold text-white/40 hover:bg-white/10 transition-all border border-white/10">Cancel</button>
                          <button onClick={handleSaveSlotEdit} className="bg-orange-500 text-white py-3 rounded-xl font-bold hover:bg-orange-600 transition-all flex items-center justify-center gap-2">
                            <Check className="w-4 h-4" />Save Time
                          </button>
                        </div>
                      </div>
                    ) : (
                      // Voice/text correction editor
                      <div className="space-y-4">
                        <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                          <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Correction Examples</p>
                          <ul className="text-white/40 text-sm space-y-1">
                            <li>"June 4th should be not available"</li>
                            <li>"Change June 3rd time to 2pm to 6pm"</li>
                            <li>"Add July 15th from 10am to 3pm"</li>
                            <li>"Remove June 10th"</li>
                          </ul>
                        </div>

                        {hasMic ? (
                          <>
                            <div className="flex flex-col items-center gap-4">
                              <motion.button whileTap={{ scale: 0.95 }} onClick={isEditRecording ? stopEditRecording : startEditRecording} className={`w-24 h-24 rounded-full flex flex-col items-center justify-center text-white shadow-lg transition-all gap-1 ${isEditRecording ? 'bg-red-500' : 'bg-orange-500 hover:bg-orange-600'}`}>
                                {isEditRecording ? <><MicOff className="w-8 h-8" /><span className="text-[10px] font-bold">Stop</span></> : <><Mic className="w-8 h-8" /><span className="text-[10px] font-bold">Speak</span></>}
                              </motion.button>
                              {isEditRecording && <div className="flex items-center gap-2 text-red-400 text-sm font-bold animate-pulse"><div className="w-2 h-2 rounded-full bg-red-400"></div>Recording correction...</div>}
                            </div>
                            {editTranscript && (
                              <div className="bg-white/5 border border-white/10 rounded-2xl p-4">
                                <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Correction heard</p>
                                <p className="text-white/80 text-sm">{editTranscript}</p>
                              </div>
                            )}
                            <p className="text-center text-white/30 text-xs">— or type it instead —</p>
                          </>
                        ) : null}

                        <textarea
                          rows={3}
                          placeholder="Type your correction here..."
                          className="w-full bg-white/10 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-white/20 outline-none focus:border-orange-500 text-sm resize-none"
                          value={editTextInput}
                          onChange={e => setEditTextInput(e.target.value)}
                        />

                        <div className="grid grid-cols-2 gap-3">
                          <button onClick={() => setSubmitStep('review')} className="py-3 rounded-xl font-bold text-white/40 hover:bg-white/10 transition-all border border-white/10">Back</button>
                          <button
                            disabled={(!editTranscript && !editTextInput) || isEditParsing}
                            onClick={handleApplyEdit}
                            className="bg-orange-500 text-white py-3 rounded-xl font-bold hover:bg-orange-600 transition-all disabled:opacity-40 flex items-center justify-center gap-2"
                          >
                            {isEditParsing ? <><Loader2 className="w-4 h-4 animate-spin" />Applying...</> : <><Check className="w-4 h-4" />Apply Correction</>}
                          </button>
                        </div>
                      </div>
                    )}
                  </motion.div>
                )}

                {/* DONE STEP */}
                {submitStep === 'done' && (
                  <motion.div key="done" initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-12 space-y-4">
                    <div className="w-20 h-20 bg-green-500/20 rounded-full flex items-center justify-center mx-auto">
                      <CheckCircle2 className="w-10 h-10 text-green-400" />
                    </div>
                    <h3 className="text-2xl font-bold">Schedule Submitted!</h3>
                    <p className="text-white/40">Your availability is in. The organizer will be notified once everyone has responded.</p>
                    <button onClick={() => { setView('home'); resetSubmit(); setActiveMeeting(null); }} className="bg-white/10 text-white px-6 py-2.5 rounded-xl font-bold hover:bg-white/20 transition-all">Back to Home</button>
                  </motion.div>
                )}

              </AnimatePresence>
            </motion.div>
          )}

          {/* RESULTS */}
          {view === 'results' && activeMeeting && (
            <motion.div key="results" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-8">
              <div className="bg-white/5 border border-white/10 rounded-3xl p-6">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <button onClick={() => { setView('home'); setActiveMeeting(null); }} className="p-1 hover:bg-white/10 rounded-lg transition-all"><ChevronRight className="w-4 h-4 rotate-180 text-white/40" /></button>
                      <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest">Meeting Group</p>
                    </div>
                    {editingTitle ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          className="text-2xl font-bold bg-white/10 border border-orange-500 rounded-xl px-3 py-1 text-white outline-none"
                          value={editTitleValue}
                          onChange={e => setEditTitleValue(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleUpdateTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
                          autoFocus
                        />
                        <button onClick={handleUpdateTitle} className="p-1.5 bg-orange-500 rounded-lg hover:bg-orange-600 transition-all"><Check className="w-4 h-4 text-white" /></button>
                        <button onClick={() => setEditingTitle(false)} className="p-1.5 bg-white/10 rounded-lg hover:bg-white/20 transition-all"><X className="w-4 h-4 text-white/60" /></button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <h2 className="text-2xl font-bold">{activeMeeting.title}</h2>
                        <button onClick={() => { setEditTitleValue(activeMeeting.title); setEditingTitle(true); }} className="p-1.5 hover:bg-white/10 rounded-lg transition-all" title="Edit title">
                          <Edit2 className="w-4 h-4 text-white/30 hover:text-white/60" />
                        </button>
                      </div>
                    )}
                    <p className="text-white/40 text-sm">Created by {activeMeeting.creatorName} · Due {formatDate(activeMeeting.deadline)}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={() => copyJoinLink(activeMeeting.id)} className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-4 py-2 rounded-xl font-bold text-sm transition-all">
                      {copiedId === activeMeeting.id ? <><Check className="w-4 h-4 text-green-400" />Copied!</> : <><Copy className="w-4 h-4" />Copy Join Link</>}
                    </button>
                    <button onClick={() => { setView('submit'); resetSubmit(); }} className="flex items-center gap-2 bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-xl font-bold text-sm transition-all">
                      <Mic className="w-4 h-4" />Submit Mine
                    </button>
                    <button
                      onClick={() => { if (window.confirm(`Delete "${activeMeeting.title}"? This cannot be undone.`)) handleDeleteMeeting(activeMeeting.id); }}
                      className="p-2 text-white/30 hover:text-red-400 hover:bg-red-500/10 rounded-xl transition-all"
                      title="Delete this meeting group"
                    >
                      <Trash2 className="w-5 h-5" />
                    </button>
                  </div>
                </div>

                <div className="mt-4 space-y-2">
                  <div className="flex justify-between text-xs text-white/40">
                    <span>{activeMeeting.participants?.length || 0} of {activeMeeting.expectedCount} submitted</span>
                    <span>{(activeMeeting.participants?.length || 0) >= activeMeeting.expectedCount ? '✅ Everyone responded!' : `Waiting on ${activeMeeting.expectedCount - (activeMeeting.participants?.length || 0)} more...`}</span>
                  </div>
                  <div className="w-full bg-white/10 rounded-full h-2">
                    <div className="bg-orange-500 h-2 rounded-full transition-all" style={{ width: `${Math.min(100, Math.round(((activeMeeting.participants?.length || 0) / activeMeeting.expectedCount) * 100))}%` }}></div>
                  </div>
                </div>

                {/* Require Code toggle — creator can change anytime */}
                <div className="mt-4 flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                  <div>
                    <p className="text-sm font-bold text-white">Require Join Code</p>
                    <p className="text-[11px] text-white/40">{activeMeeting.requireCode ? 'New participants must enter the meeting ID' : 'Anyone with the link can join directly'}</p>
                  </div>
                  <button
                    onClick={async () => {
                      await updateDoc(doc(db, 'meetingGroups', activeMeeting.id), { requireCode: !activeMeeting.requireCode });
                    }}
                    className={`relative w-12 h-6 rounded-full transition-all ${activeMeeting.requireCode ? 'bg-orange-500' : 'bg-white/20'}`}
                  >
                    <div className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all shadow ${activeMeeting.requireCode ? 'left-6' : 'left-0.5'}`} />
                  </button>
                </div>

                {activeMeeting.participants?.length > 0 && (
                  <div className="mt-4">
                    <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Submitted</p>
                    <div className="flex flex-wrap gap-2">
                      {activeMeeting.participants.map(p => (
                        <div key={p.id} className="relative">
                          <button
                            onClick={() => setExpandedParticipantId(expandedParticipantId === p.id ? null : p.id)}
                            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold transition-all ${expandedParticipantId === p.id ? 'bg-orange-500/30 text-orange-300 ring-1 ring-orange-500/40' : 'bg-green-500/20 text-green-400'}`}
                          >
                            <CheckCircle2 className="w-3 h-3" />{p.name}
                          </button>
                          {expandedParticipantId === p.id && (
                            <div className="absolute top-full left-0 mt-1 bg-gray-900 border border-white/20 rounded-xl shadow-xl z-20 overflow-hidden min-w-[160px]">
                              <button
                                onClick={() => { setViewingParticipant(p); setExpandedParticipantId(null); }}
                                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-white hover:bg-white/10 transition-all"
                              >
                                <CalendarIcon className="w-4 h-4 text-orange-400" />View Schedule
                              </button>
                              <button
                                onClick={() => { if (window.confirm(`Remove ${p.name}? Their schedule will be archived and can be restored.`)) { handleRemoveParticipant(p.id); setExpandedParticipantId(null); } }}
                                className="w-full flex items-center gap-2 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-all border-t border-white/10"
                              >
                                <Trash2 className="w-4 h-4" />Archive
                              </button>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* View participant schedule modal */}
                {viewingParticipant && (
                  <div className="mt-4 bg-white/5 border border-orange-500/30 rounded-2xl p-5">
                    <div className="flex justify-between items-center mb-4">
                      <div>
                        <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest">{viewingParticipant.name}'s Schedule</p>
                        <p className="text-[10px] text-white/20">Submitted {new Date(viewingParticipant.submittedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p>
                      </div>
                      <button onClick={() => setViewingParticipant(null)} className="p-1.5 hover:bg-white/10 rounded-lg transition-all"><X className="w-4 h-4 text-white/40" /></button>
                    </div>
                    <div className="space-y-2">
                      {viewingParticipant.slots.filter(s => !s.unavailable).length > 0 ? (
                        viewingParticipant.slots.filter(s => !s.unavailable).map((slot, i) => (
                          <div key={i} className="flex items-center justify-between bg-green-500/10 border border-green-500/20 rounded-xl px-4 py-2.5">
                            <p className="font-bold text-white text-sm">{formatDateFull(slot.date)}</p>
                            <p className="text-green-400 font-bold text-sm">{formatTime(slot.start)} – {formatTime(slot.end)}</p>
                          </div>
                        ))
                      ) : (
                        <p className="text-white/30 text-sm text-center py-4">No available slots submitted.</p>
                      )}
                      {viewingParticipant.slots.filter(s => s.unavailable).length > 0 && (
                        <div className="mt-2">
                          <p className="text-[10px] font-bold text-red-400/60 uppercase tracking-widest mb-1">Not Available</p>
                          {viewingParticipant.slots.filter(s => s.unavailable).map((slot, i) => (
                            <div key={i} className="bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-2 mb-1">
                              <p className="font-bold text-white/40 text-sm line-through">{formatDateFull(slot.date)}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {(activeMeeting.archivedParticipants?.length || 0) > 0 && (
                  <div className="mt-3">
                    <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2">Removed (tap to restore)</p>
                    <div className="flex flex-wrap gap-2">
                      {activeMeeting.archivedParticipants!.map(p => (
                        <button
                          key={p.id}
                          onClick={() => handleRestoreParticipant(p.id)}
                          className="inline-flex items-center gap-1.5 bg-white/5 text-white/30 px-3 py-1 rounded-full text-xs font-bold hover:bg-white/10 hover:text-white/60 transition-all"
                          title={`Restore ${p.name}'s schedule`}
                        >
                          <PlusCircle className="w-3 h-3" />{p.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {(activeMeeting.participants?.length || 0) >= 2 ? (
                <div className="space-y-8">
                  <section>
                    <div className="flex items-center gap-3 mb-4">
                      <div className="h-px flex-1 bg-white/10"></div>
                      <h3 className="text-xs font-bold text-white/30 uppercase tracking-widest px-3">Everyone Available</h3>
                      <div className="h-px flex-1 bg-white/10"></div>
                    </div>
                    {fullMatches.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {fullMatches.map((result, i) => <SyncCard key={i} result={result} totalCount={activeMeeting.participants.length} />)}
                      </div>
                    ) : (
                      <div className="text-center py-10 bg-white/5 rounded-2xl border border-dashed border-white/10">
                        <p className="text-white/30 text-sm">No dates yet where everyone overlaps.</p>
                      </div>
                    )}
                  </section>

                  {partialMatches.length > 0 && (
                    <section>
                      <div className="flex items-center gap-3 mb-4">
                        <div className="h-px flex-1 bg-white/10"></div>
                        <h3 className="text-xs font-bold text-white/30 uppercase tracking-widest px-3">Partial Availability</h3>
                        <div className="h-px flex-1 bg-white/10"></div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 opacity-70">
                        {partialMatches.map((result, i) => <SyncCard key={i} result={result} totalCount={activeMeeting.participants.length} />)}
                      </div>
                    </section>
                  )}
                </div>
              ) : (
                <div className="text-center py-20 bg-white/5 rounded-3xl border border-dashed border-white/10">
                  <Users className="w-12 h-12 text-white/20 mx-auto mb-4" />
                  <h3 className="text-lg font-bold text-white/60">Waiting for responses</h3>
                  <p className="text-white/30 text-sm max-w-xs mx-auto mt-2">Share the join link with your team. Sync results appear automatically once at least 2 people submit.</p>
                </div>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}

// --- Sync Card ---
function SyncCard({ result, totalCount }: { result: SyncResult; totalCount: number }) {
  return (
    <motion.div whileHover={{ y: -3 }} className={`bg-white/5 border rounded-2xl p-5 ${result.isFull ? 'border-orange-500/40 ring-1 ring-orange-500/10' : 'border-white/10'}`}>
      <div className="flex justify-between items-start mb-4">
        <div>
          <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-1">Available</p>
          <h3 className="text-lg font-extrabold text-white">{formatDate(result.date)}</h3>
        </div>
        <div className={`px-2 py-1 rounded-full text-[10px] font-bold uppercase ${result.isFull ? 'bg-orange-500 text-white' : 'bg-white/10 text-white/60'}`}>
          {result.isFull ? 'All Free' : `${result.participantNames.length}/${totalCount}`}
        </div>
      </div>
      <div className="space-y-2 mb-4">
        {result.slots.map((slot, i) => (
          <div key={i} className="flex items-center gap-2 bg-white/5 rounded-xl px-3 py-2">
            <Clock className="w-4 h-4 text-orange-400 shrink-0" />
            <span className="text-white font-bold text-sm">{formatTime(slot.start)} – {formatTime(slot.end)}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1">
        {result.participantNames.map((name, i) => (
          <span key={i} className="bg-white/10 text-white/60 px-2 py-0.5 rounded-lg text-[11px] font-bold">{name.split(' ')[0]}</span>
        ))}
      </div>
    </motion.div>
  );
}
