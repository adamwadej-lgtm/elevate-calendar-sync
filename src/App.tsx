/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo } from 'react';
import { 
  Users, 
  Calendar as CalendarIcon, 
  Plus, 
  Trash2, 
  Edit2, 
  Save, 
  X, 
  Settings as SettingsIcon,
  CheckCircle2,
  Clock,
  ChevronRight,
  UserPlus
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';

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

// --- Firebase Helpers ---
const saveProfilesToFirebase = async (profiles: Profile[]) => {
  try {
    await setDoc(doc(db, 'appData', 'profiles'), { profiles });
  } catch (e) {
    console.error('Error saving profiles:', e);
  }
};

const saveEventsToFirebase = async (events: AppEvent[]) => {
  try {
    await setDoc(doc(db, 'appData', 'events'), { events });
  } catch (e) {
    console.error('Error saving events:', e);
  }
};

// --- Types ---

type TimeRange = {
  start: string; // "HH:mm"
  end: string;   // "HH:mm"
};

type DailySchedule = Record<number, TimeRange[]>; // 0-6 (Sun-Sat)

type Availability = {
  weekA: DailySchedule;
  weekB: DailySchedule;
};

type Profile = {
  id: string;
  name: string;
  startDate: string; // Start date for Schedule One
  availability: Availability; // Schedule One
  hasScheduleTwo: boolean;
  scheduleTwo?: {
    startDate: string;
    availability: Availability;
  };
};

type SyncResult = {
  date: Date;
  isWeekA: boolean;
  availableMembers: string[]; // ids
  overlapRanges: TimeRange[];
  matchType: 'full' | 'partial';
};

type AppEvent = {
  id: string;
  title: string;
  eventDates: string[]; // dates it takes place e.g. ["2026-05-12"]
  planningStartDate: string;
  planningEndDate: string;
  memberIds: string[];
};

// --- Utils ---

const DAYS = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

const getSundays = () => {
  const sundays = [];
  const now = new Date();
  
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  start.setHours(0,0,0,0);

  for (let i = 0; i < 10; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + (i * 7));
    sundays.push(d.toISOString().split('T')[0]);
  }
  return sundays;
};

const generateId = () => Math.random().toString(36).substr(2, 9);

const formatTime = (time: string) => {
  if (!time) return '';
  const [hours, minutes] = time.split(':').map(Number);
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h = hours % 12 || 12;
  return `${h}:${minutes.toString().padStart(2, '0')} ${ampm}`;
};

const getIntersection = (schedules: TimeRange[][]): TimeRange[] => {
  if (schedules.length === 0) return [];
  
  let commonRanges = [...schedules[0]];

  for (let i = 1; i < schedules.length; i++) {
    const personRanges = schedules[i];
    const nextCommon: TimeRange[] = [];

    for (const a of commonRanges) {
      for (const b of personRanges) {
        const intersection = getSingleIntersection(a, b);
        if (intersection) {
          nextCommon.push(intersection);
        }
      }
    }
    commonRanges = nextCommon;
    if (commonRanges.length === 0) break;
  }

  return commonRanges;
};

const getSingleIntersection = (r1: TimeRange, r2: TimeRange): TimeRange | null => {
  const [s1H, s1M] = r1.start.split(':').map(Number);
  const [e1H, e1M] = r1.end.split(':').map(Number);
  const [s2H, s2M] = r2.start.split(':').map(Number);
  const [e2H, e2M] = r2.end.split(':').map(Number);

  const startMinutes = Math.max(s1H * 60 + s1M, s2H * 60 + s2M);
  const endMinutes = Math.min(e1H * 60 + e1M, e2H * 60 + e2M);

  if (startMinutes >= endMinutes) return null;

  return {
    start: `${Math.floor(startMinutes / 60).toString().padStart(2, '0')}:${(startMinutes % 60).toString().padStart(2, '0')}`,
    end: `${Math.floor(endMinutes / 60).toString().padStart(2, '0')}:${(endMinutes % 60).toString().padStart(2, '0')}`
  };
};

// --- Components ---

export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [activeEventId, setActiveEventId] = useState<string | null>(null);
  const [isEventModalOpen, setIsEventModalOpen] = useState(false);
  const [editingEvent, setEditingEvent] = useState<Partial<AppEvent>>({
    title: '',
    eventDates: [],
    planningStartDate: new Date().toISOString().split('T')[0],
    planningEndDate: '',
    memberIds: []
  });

  // Real-time Firebase listeners
  useEffect(() => {
    const unsubProfiles = onSnapshot(doc(db, 'appData', 'profiles'), (snap) => {
      if (snap.exists()) {
        const raw = snap.data().profiles || [];
        const normalized = raw.map((p: any) => {
          const p1 = {
            ...p,
            hasScheduleTwo: p.hasScheduleTwo || false,
            startDate: p.startDate || getSundays()[0],
            availability: {
              weekA: Object.fromEntries(DAYS.map(d => [d.value, Array.isArray(p.availability?.weekA?.[d.value]) ? p.availability.weekA[d.value] : (p.availability?.weekA?.[d.value] ? [p.availability.weekA[d.value]] : [])])),
              weekB: Object.fromEntries(DAYS.map(d => [d.value, Array.isArray(p.availability?.weekB?.[d.value]) ? p.availability.weekB[d.value] : (p.availability?.weekB?.[d.value] ? [p.availability.weekB[d.value]] : [])])),
            }
          };
          if (p1.hasScheduleTwo && p1.scheduleTwo) {
            p1.scheduleTwo.availability = {
              weekA: Object.fromEntries(DAYS.map(d => [d.value, Array.isArray(p1.scheduleTwo.availability?.weekA?.[d.value]) ? p1.scheduleTwo.availability.weekA[d.value] : (p1.scheduleTwo.availability?.weekA?.[d.value] ? [p1.scheduleTwo.availability.weekA[d.value]] : [])])),
              weekB: Object.fromEntries(DAYS.map(d => [d.value, Array.isArray(p1.scheduleTwo.availability?.weekB?.[d.value]) ? p1.scheduleTwo.availability.weekB[d.value] : (p1.scheduleTwo.availability?.weekB?.[d.value] ? [p1.scheduleTwo.availability.weekB[d.value]] : [])])),
            };
          }
          return p1;
        });
        setProfiles(normalized);
      }
      setIsLoading(false);
    }, (err) => {
      console.error('Profiles listener error:', err);
      setIsLoading(false);
    });

    const unsubEvents = onSnapshot(doc(db, 'appData', 'events'), (snap) => {
      if (snap.exists()) {
        setEvents(snap.data().events || []);
      }
    }, (err) => {
      console.error('Events listener error:', err);
    });

    return () => {
      unsubProfiles();
      unsubEvents();
    };
  }, []);

  // UI State
  const [activeTab, setActiveTab] = useState<'sync' | 'members' | 'settings'>('sync');
  const [editingProfile, setEditingProfile] = useState<Profile | null>(null);
  const [profileToDelete, setProfileToDelete] = useState<Profile | null>(null);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([]);
  const [isDeletingBulk, setIsDeletingBulk] = useState(false);
  const [eventToDelete, setEventToDelete] = useState<AppEvent | null>(null);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);

  const [profileError, setProfileError] = useState<string | null>(null);
  const [eventError, setEventError] = useState<string | null>(null);

  const [activeEditingSchedule, setActiveEditingSchedule] = useState<1 | 2>(1);

  // Sync Active Event Members
  useEffect(() => {
    if (activeEventId) {
      const activeEvent = events.find(e => e.id === activeEventId);
      if (activeEvent) {
        setSelectedMemberIds(activeEvent.memberIds || []);
      }
    } else {
      setSelectedMemberIds([]);
    }
  }, [activeEventId, events.length]);

  // Persist local selection to Event via Firebase
  useEffect(() => {
    if (activeEventId) {
      const updatedEvents = events.map(ev => {
        if (ev.id === activeEventId) {
          if (JSON.stringify(ev.memberIds) !== JSON.stringify(selectedMemberIds)) {
            return { ...ev, memberIds: selectedMemberIds };
          }
        }
        return ev;
      });
      const changed = updatedEvents.some((ev, i) => ev !== events[i]);
      if (changed) saveEventsToFirebase(updatedEvents);
    }
  }, [selectedMemberIds, activeEventId]);

  // Sync Logic
  const sortedProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => {
      const aSelected = selectedMemberIds.includes(a.id);
      const bSelected = selectedMemberIds.includes(b.id);
      
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      
      return a.name.localeCompare(b.name);
    });
  }, [profiles, selectedMemberIds]);

  const alphabeticalProfiles = useMemo(() => {
    return [...profiles].sort((a, b) => a.name.localeCompare(b.name));
  }, [profiles]);

  const categorizedEvents = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const upcoming: AppEvent[] = [];
    const past: AppEvent[] = [];
    
    events.forEach(ev => {
      let isPast = false;
      if (ev.eventDates && ev.eventDates.length > 0) {
        const latestDate = new Date(Math.max(...ev.eventDates.map(d => new Date(d + 'T23:59:59').getTime())));
        isPast = latestDate < today;
      } else {
        isPast = new Date(ev.planningEndDate + 'T23:59:59') < today;
      }
      
      if (isPast) past.push(ev);
      else upcoming.push(ev);
    });
    
    const sortByDate = (a: AppEvent, b: AppEvent) => {
      const dateA = a.eventDates?.[0] || a.planningStartDate;
      const dateB = b.eventDates?.[0] || b.planningStartDate;
      return new Date(dateA).getTime() - new Date(dateB).getTime();
    };

    return { 
      upcoming: upcoming.sort(sortByDate), 
      past: past.sort((a, b) => sortByDate(b, a))
    };
  }, [events]);

  const handleBulkDeleteEvents = () => {
    if (selectedEventIds.length === 0) return;
    const updatedEvents = events.filter(ev => !selectedEventIds.includes(ev.id));
    saveEventsToFirebase(updatedEvents);
    if (activeEventId && selectedEventIds.includes(activeEventId)) {
      setActiveEventId(null);
    }
    setSelectedEventIds([]);
    setIsDeletingBulk(false);
  };

  const getEffectiveAvailability = (profile: Profile, targetDate: Date) => {
    const targetStr = targetDate.toISOString().split('T')[0];
    
    // Check if Schedule Two is active and date is >= its start date
    if (profile.hasScheduleTwo && profile.scheduleTwo && targetStr >= profile.scheduleTwo.startDate) {
      return {
        startDate: profile.scheduleTwo.startDate,
        availability: profile.scheduleTwo.availability
      };
    }
    
    // Default to Schedule One
    return {
      startDate: profile.startDate,
      availability: profile.availability
    };
  };

  const syncResults = useMemo(() => {
    if (selectedMemberIds.length < 1 || !activeEventId) return [];
    
    const activeEvent = events.find(e => e.id === activeEventId);
    if (!activeEvent) return [];
    
    let rangeStart = new Date(activeEvent.planningStartDate + 'T00:00:00');
    let rangeEnd = new Date(activeEvent.planningEndDate + 'T23:59:59');

    const results: SyncResult[] = [];
    
    const daysDiff = Math.floor((rangeEnd.getTime() - rangeStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const iterations = Math.min(Math.max(daysDiff, 1), 100); // Safety cap

    for (let i = 0; i < iterations; i++) {
      const d = new Date(rangeStart);
      d.setDate(d.getDate() + i);
      
      const dayOfWeek = d.getDay();
      
      const availableMembers: string[] = [];
      const memberSchedules: TimeRange[][] = [];

      selectedMemberIds.forEach(id => {
        const profile = profiles.find(p => p.id === id);
        if (!profile) return;

        const { startDate, availability } = getEffectiveAvailability(profile, d);
        const profileAnchor = new Date(startDate + 'T12:00:00');
        const pDiffDays = Math.floor((d.getTime() - profileAnchor.getTime()) / (1000 * 60 * 60 * 24));
        const pWeekIndex = Math.floor(pDiffDays / 7);
        const pModWeek = ((pWeekIndex % 2) + 2) % 2;
        const pIsWeekA = pModWeek === 0;

        const sched = pIsWeekA ? availability.weekA : availability.weekB;
        const dayScheds = sched[dayOfWeek] || [];
        if (dayScheds.length > 0) {
          availableMembers.push(id);
          memberSchedules.push(dayScheds);
        }
      });

      if (availableMembers.length >= 1) {
        const overlaps = getIntersection(memberSchedules);
        results.push({
          date: d,
          isWeekA: true, // Legacy field, no longer globally significant
          availableMembers,
          overlapRanges: overlaps,
          matchType: availableMembers.length === selectedMemberIds.length ? 'full' : 'partial'
        });
      }
    }

    return results.sort((a, b) => a.date.getTime() - b.date.getTime());
  }, [selectedMemberIds, profiles, activeEventId, events]);

  const fullMatches = syncResults.filter(r => r.matchType === 'full' && r.overlapRanges.length > 0);
  const partialMatches = syncResults.filter(r => r.matchType === 'partial' || (r.matchType === 'full' && r.overlapRanges.length === 0));

  const handleEditProfile = (profile: Profile) => {
    setProfileError(null);
    setActiveEditingSchedule(1);
    // Ensure the start date is set and snapped to Sunday
    const currentStart = profile.startDate || new Date().toISOString().split('T')[0];
    const d = new Date(currentStart + 'T12:00:00');
    let fixedDate = currentStart;
    
    if (d.getDay() !== 0) {
      d.setDate(d.getDate() - d.getDay());
      fixedDate = d.toISOString().split('T')[0];
    }

    setEditingProfile({
      ...profile,
      startDate: fixedDate
    });
    setIsProfileModalOpen(true);
  };

  const handleDeleteProfile = (id: string) => {
    const profile = profiles.find(p => p.id === id);
    if (profile) {
      setProfileToDelete(profile);
    }
  };

  const confirmDeleteProfile = () => {
    if (profileToDelete) {
      const id = profileToDelete.id;
      const updatedProfiles = profiles.filter(p => p.id !== id);
      saveProfilesToFirebase(updatedProfiles);
      setSelectedMemberIds(prev => prev.filter(mid => mid !== id));
      setProfileToDelete(null);
    }
  };

  const handleSaveProfile = (profile: Profile) => {
    if (!profile.name || !profile.name.trim()) {
      setProfileError("Please enter a member name before saving.");
      return;
    }
    setProfileError(null);
    const finalProfile = { ...profile, startDate: profile.startDate || getSundays()[0] };
    let updatedProfiles;
    if (profiles.find(p => p.id === finalProfile.id)) {
      updatedProfiles = profiles.map(p => p.id === finalProfile.id ? finalProfile : p);
    } else {
      updatedProfiles = [...profiles, finalProfile];
    }
    saveProfilesToFirebase(updatedProfiles);
    setIsProfileModalOpen(false);
    setEditingProfile(null);
  };

  const handleSaveEvent = () => {
    if (!editingEvent.title || !editingEvent.planningEndDate) {
      setEventError("Please fill in both the event title and the planning end date.");
      return;
    }
    setEventError(null);
    
    const newEvent: AppEvent = {
      id: editingEvent.id || generateId(),
      title: editingEvent.title!,
      eventDates: (editingEvent.eventDates || []).filter(d => !!d),
      planningStartDate: editingEvent.planningStartDate || new Date().toISOString().split('T')[0],
      planningEndDate: editingEvent.planningEndDate!,
      memberIds: editingEvent.memberIds || []
    };

    let updatedEvents;
    if (editingEvent.id) {
      updatedEvents = events.map(ev => ev.id === editingEvent.id ? newEvent : ev);
    } else {
      updatedEvents = [...events, newEvent];
      setActiveEventId(newEvent.id);
      setActiveTab('sync');
    }
    saveEventsToFirebase(updatedEvents);
    setIsEventModalOpen(false);
  };

  const handleDeleteEvent = (id: string) => {
    const event = events.find(ev => ev.id === id);
    if (event) {
      setEventToDelete(event);
    }
  };

  const confirmDeleteEvent = () => {
    if (eventToDelete) {
      const id = eventToDelete.id;
      const updatedEvents = events.filter(ev => ev.id !== id);
      saveEventsToFirebase(updatedEvents);
      if (activeEventId === id) setActiveEventId(null);
      setEventToDelete(null);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-brand-orange border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-brand-navy font-bold">Loading Elevate Calendar Sync...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans">
      {/* Header */}
      <header className="bg-brand-navy text-white shadow-lg p-4 sm:px-8">
        <div className="max-w-7xl mx-auto flex justify-between items-center">
          <div 
            className="flex items-center gap-3 cursor-pointer group"
            onClick={() => {
              setActiveTab('sync');
              setActiveEventId(null);
            }}
          >
            <div className="bg-brand-orange p-2 rounded-xl group-hover:scale-110 transition-transform">
              <Users className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">Elevate Calendar Sync</h1>
            </div>
          </div>
          
          <div className="hidden md:flex items-center gap-4">
            <button 
              onClick={() => {
                setEditingEvent({
                  title: '',
                  eventDates: [''],
                  planningStartDate: new Date().toISOString().split('T')[0],
                  planningEndDate: ''
                });
                setEventError(null);
                setIsEventModalOpen(true);
              }}
              className="bg-brand-orange text-white px-4 py-2 rounded-xl font-bold flex items-center gap-2 hover:bg-orange-600 transition-all shadow-md active:scale-95 text-sm"
            >
              <Plus className="w-4 h-4" />
              New Event
            </button>

            <nav className="flex gap-1 bg-white/10 p-1 rounded-lg">
              <TabButton active={activeTab === 'sync'} onClick={() => setActiveTab('sync')} icon={<CalendarIcon className="w-4 h-4" />}>Calendar Sync</TabButton>
              <TabButton active={activeTab === 'members'} onClick={() => setActiveTab('members')} icon={<Users className="w-4 h-4" />}>Members</TabButton>
              <TabButton active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} icon={<SettingsIcon className="w-4 h-4" />}>Settings</TabButton>
            </nav>
          </div>

          <div className="md:hidden">
            <MenuIcon 
              activeTab={activeTab} 
              setActiveTab={setActiveTab} 
              setEditingEvent={setEditingEvent}
              setIsEventModalOpen={setIsEventModalOpen}
            />
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full p-4 sm:p-8">
        <AnimatePresence mode="wait">
          {activeTab === 'sync' && (
            <motion.div 
              key="sync"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-8"
            >
              {events.length > 0 && (
                <div className="p-4 bg-white rounded-2xl border border-brand-navy/10 shadow-sm flex items-center justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <div className="p-2 bg-brand-navy/5 rounded-xl text-brand-navy">
                       <CalendarIcon className="w-5 h-5" />
                    </div>
                    <div>
                      <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none mb-1">Planning Context</p>
                      <select 
                        className="bg-transparent font-bold text-brand-navy outline-none cursor-pointer text-lg leading-tight"
                        value={activeEventId || ''}
                        onChange={e => setActiveEventId(e.target.value || null)}
                      >
                         <option value="" disabled>Select an Event Context...</option>
                         {events.map(ev => {
                            const isPast = ev.eventDates?.[0] && new Date(ev.eventDates[0] + 'T23:59:59') < new Date();
                            return (
                              <option key={ev.id} value={ev.id}>
                                {isPast ? '󰄱 [Past] ' : ''}Event: {ev.title}
                              </option>
                            );
                         })}
                      </select>
                    </div>
                  </div>
                  {activeEventId && (() => {
                    const activeEvent = events.find(e => e.id === activeEventId);
                    if (!activeEvent) return null;
                    const firstDate = activeEvent.eventDates?.[0] ? new Date(activeEvent.eventDates[0] + 'T12:00:00') : null;
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    const diffDays = firstDate ? Math.ceil((new Date(activeEvent.eventDates[0] + 'T00:00:00').getTime() - today.getTime()) / (1000 * 60 * 60 * 24)) : null;
                    const hasPassed = diffDays !== null && diffDays < 0;

                    return (
                      <div className={`flex items-center gap-6 ${hasPassed ? 'opacity-60 grayscale-[0.5]' : ''}`}>
                        <div className="hidden sm:block text-right">
                          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none mb-1">Planning Range</p>
                          <p className="text-xs font-bold text-brand-navy">
                            {new Date(activeEvent.planningStartDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – {new Date(activeEvent.planningEndDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </p>
                        </div>
                        
                        <div className="hidden lg:block text-right border-l pl-6 border-gray-100">
                          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none mb-1">Event Date</p>
                          <p className="text-xs font-bold text-brand-navy">
                            {firstDate ? firstDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'TBD'}
                          </p>
                        </div>

                        <div className="hidden lg:block text-right border-l pl-6 border-gray-100">
                          <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none mb-1">Countdown</p>
                          <p className={`text-xs font-bold ${diffDays !== null && diffDays <= 7 && !hasPassed ? 'text-brand-orange' : 'text-brand-navy'}`}>
                            {diffDays !== null ? (diffDays < 0 ? 'Completed' : diffDays === 0 ? 'Today!' : `${diffDays} Days Left`) : '—'}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 border-l pl-4 border-gray-100">
                          <button 
                            onClick={() => {
                              setEditingEvent(activeEvent);
                              setIsEventModalOpen(true);
                            }}
                            className="p-2 text-gray-400 hover:text-brand-navy hover:bg-gray-50 rounded-xl transition-all"
                            title="Edit Event"
                          >
                            <Edit2 className="w-5 h-5" />
                          </button>
                          <button 
                            onClick={() => setActiveEventId(null)}
                            className="p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
                            title="Exit Event View"
                          >
                            <X className="w-5 h-5" />
                          </button>
                        </div>
                      </div>
                    );
                  })()}
                </div>
              )}

              <section className="bg-white rounded-3xl shadow-sm border border-gray-100 p-6">
                <div className="flex flex-col md:flex-row md:items-end gap-6">
                  <div className="flex-1 space-y-4">
                    <label className="text-sm font-semibold text-gray-500 uppercase tracking-wider">Step 1: Add Members to this team</label>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {sortedProfiles.map(profile => (
                        <label 
                          key={profile.id}
                          className={`flex items-center gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                            selectedMemberIds.includes(profile.id) 
                              ? 'bg-brand-orange/10 border-brand-orange text-brand-orange' 
                              : 'bg-white border-gray-200 hover:border-gray-300'
                          }`}
                        >
                          <input 
                            type="checkbox" 
                            className="hidden"
                            checked={selectedMemberIds.includes(profile.id)}
                            onChange={() => {
                              setSelectedMemberIds(prev => 
                                prev.includes(profile.id) 
                                  ? prev.filter(id => id !== profile.id) 
                                  : [...prev, profile.id]
                              );
                            }}
                          />
                          <div className={`w-5 h-5 rounded-md border flex items-center justify-center ${selectedMemberIds.includes(profile.id) ? 'bg-brand-orange border-brand-orange text-white' : 'border-gray-300'}`}>
                            {selectedMemberIds.includes(profile.id) && <CheckCircle2 className="w-4 h-4" />}
                          </div>
                          <div>
                            <p className="font-semibold text-sm leading-tight">{profile.name}</p>
                          </div>
                        </label>
                      ))}
                    </div>
                  </div>

                  {selectedMemberIds.length > 0 && (
                    <div className="bg-brand-navy text-white p-6 rounded-2xl md:w-64 flex flex-col justify-center text-center">
                      <p className="text-4xl font-bold mb-1">{selectedMemberIds.length}</p>
                      <p className="text-blue-200 text-xs uppercase font-medium tracking-widest">Members Selected</p>
                    </div>
                  )}
                </div>
              </section>

              {selectedMemberIds.length > 0 ? (
                <div className="space-y-12">
                  {!activeEventId ? (
                    <div className="text-center py-20 bg-brand-navy/5 rounded-[2.5rem] border border-dashed border-brand-navy/20">
                      <CalendarIcon className="w-12 h-12 text-brand-navy/20 mx-auto mb-4" />
                      <h3 className="text-lg font-bold text-brand-navy">Select a Planning Context</h3>
                      <p className="text-gray-500 max-w-xs mx-auto text-sm mb-6">Choose an event from the top menu or create a "New Event" to start syncing your team for specific programs.</p>
                      <button 
                        onClick={() => {
                          setEditingEvent({
                            title: '',
                            eventDates: [''],
                            planningStartDate: new Date().toISOString().split('T')[0],
                            planningEndDate: ''
                          });
                          setIsEventModalOpen(true);
                        }}
                        className="bg-brand-orange text-white px-6 py-2.5 rounded-xl font-bold shadow-md hover:bg-orange-600 transition-all text-sm inline-flex items-center gap-2"
                      >
                        <Plus className="w-4 h-4" />
                        Create Your First Event
                      </button>
                    </div>
                  ) : syncResults.length > 0 ? (
                    <>
                      {/* Full Matches */}
                      <section>
                        <div className="flex items-center gap-3 mb-6">
                          <div className="h-px flex-1 bg-gray-200"></div>
                          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-[0.2em] px-4">Perfect Sync: Everyone Free</h2>
                          <div className="h-px flex-1 bg-gray-200"></div>
                        </div>
                        {fullMatches.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                            {fullMatches.map((res, i) => (
                              <ResultCard key={i} result={res} profiles={profiles} />
                            ))}
                          </div>
                        ) : (
                          <div className="text-center py-12 bg-white rounded-3xl border border-dashed border-gray-300">
                            <CalendarIcon className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                            <p className="text-gray-500 font-medium">No dates where everyone is overlapping in this window.</p>
                            <p className="text-gray-400 text-sm">Try adjusting individual schedules or the planning context.</p>
                          </div>
                        )}
                      </section>

                      {/* Partial Matches */}
                      <section>
                        <div className="flex items-center gap-3 mb-6">
                          <div className="h-px flex-1 bg-gray-200"></div>
                          <h2 className="text-sm font-bold text-gray-400 uppercase tracking-[0.2em] px-4">Partial Sync: High Availability</h2>
                          <div className="h-px flex-1 bg-gray-200"></div>
                        </div>
                        {partialMatches.length > 0 ? (
                          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 opacity-80">
                            {partialMatches.map((res, i) => (
                              <ResultCard key={i} result={res} profiles={profiles} totalSelected={selectedMemberIds.length} />
                            ))}
                          </div>
                        ) : (
                          <div className="text-center py-8">
                            <p className="text-gray-400 text-sm">No partial sync dates found.</p>
                          </div>
                        )}
                      </section>
                    </>
                  ) : (
                    <div className="text-center py-24 bg-white rounded-[2.5rem] border border-gray-100 shadow-sm">
                       <CalendarIcon className="w-16 h-16 text-gray-100 mx-auto mb-4" />
                       <h2 className="text-2xl font-bold text-gray-900 mb-2">No sync found for this range</h2>
                       <p className="text-gray-500 max-w-sm mx-auto">Everyone appears to be busy during the selected planning window. Try adjusting member schedules.</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-center py-24">
                   <div className="mb-6 inline-flex p-4 rounded-full bg-blue-50 text-brand-navy">
                      <Users className="w-10 h-10" />
                   </div>
                   <h2 className="text-2xl font-bold text-gray-900 mb-2">Ready to Sync?</h2>
                   <p className="text-gray-500 max-w-sm mx-auto">Select or create +New Event then select team members, and app will automatically begin finding availability to meet.</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'members' && (
            <motion.div 
               key="members"
               initial={{ opacity: 0, x: 20 }}
               animate={{ opacity: 1, x: 0 }}
               className="space-y-6"
            >
              <div className="flex justify-between items-center">
                <h2 className="text-2xl font-bold text-brand-navy">Team Directory</h2>
                <button 
                  onClick={() => {
                    setEditingProfile({
                      id: generateId(),
                      name: '',
                      startDate: (() => {
                        const d = new Date();
                        d.setDate(d.getDate() - d.getDay());
                        return d.toISOString().split('T')[0];
                      })(),
                      availability: { 
                        weekA: Object.fromEntries(DAYS.map(d => [d.value, []])), 
                        weekB: Object.fromEntries(DAYS.map(d => [d.value, []])) 
                      },
                      hasScheduleTwo: false
                    });
                    setProfileError(null);
                    setActiveEditingSchedule(1);
                    setIsProfileModalOpen(true);
                  }}
                  className="bg-brand-orange text-white px-6 py-2.5 rounded-xl font-bold shadow-sm hover:shadow-md hover:bg-orange-600 transition-all flex items-center gap-2"
                >
                  <Plus className="w-5 h-5" />
                  Add Member
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                {alphabeticalProfiles.map(profile => (
                  <ProfileCard 
                    key={profile.id} 
                    profile={profile} 
                    onEdit={() => handleEditProfile(profile)}
                    onDelete={() => handleDeleteProfile(profile.id)}
                  />
                ))}
              </div>

              {profiles.length === 0 && (
                <div className="text-center py-32 bg-white rounded-3xl border border-gray-100 shadow-sm">
                  <UserPlus className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                  <p className="text-gray-500 font-medium">Your directory is empty.</p>
                  <p className="text-gray-400 text-sm">Add your first employee profile to start syncing.</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'settings' && (
            <motion.div 
               key="settings"
               initial={{ opacity: 0, scale: 0.95 }}
               animate={{ opacity: 1, scale: 1 }}
               className="max-w-4xl mx-auto py-12 space-y-8"
            >
              {/* Event Management Section */}
              <div className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
                  <div className="flex items-center gap-4">
                    <div className="p-3 rounded-2xl bg-orange-50 text-brand-orange">
                      <CalendarIcon className="w-6 h-6" />
                    </div>
                    <div>
                      <h2 className="text-2xl font-bold">Event Management</h2>
                      <p className="text-sm text-gray-500">Manage your planning contexts and context-specific availability.</p>
                    </div>
                  </div>
                  
                  {selectedEventIds.length > 0 && (
                    <motion.div 
                      initial={{ opacity: 0, x: 20 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="flex items-center gap-3"
                    >
                      <span className="text-sm font-bold text-gray-500">{selectedEventIds.length} Selected</span>
                      <button 
                        onClick={() => setIsDeletingBulk(true)}
                        className="bg-red-50 text-red-600 px-4 py-2 rounded-xl font-bold text-sm flex items-center gap-2 hover:bg-red-100 transition-all border border-red-100"
                      >
                        <Trash2 className="w-4 h-4" />
                        Cancel Selected
                      </button>
                    </motion.div>
                  )}
                </div>

                <div className="space-y-12">
                  {/* Upcoming Events */}
                  <section className="space-y-4">
                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-1">Upcoming Events</h3>
                    {categorizedEvents.upcoming.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {categorizedEvents.upcoming.map(ev => (
                          <EventManagementCard 
                            key={ev.id}
                            event={ev}
                            isSelected={selectedEventIds.includes(ev.id)}
                            onToggleSelect={() => {
                              setSelectedEventIds(prev => 
                                prev.includes(ev.id) ? prev.filter(id => id !== ev.id) : [...prev, ev.id]
                              );
                            }}
                            onEdit={() => {
                              setEditingEvent(ev);
                              setIsEventModalOpen(true);
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="py-12 text-center bg-gray-50 rounded-2xl border border-dashed border-gray-200">
                        <p className="text-sm text-gray-400">No upcoming events found.</p>
                      </div>
                    )}
                  </section>

                  {/* Past Events */}
                  <section className="space-y-4">
                    <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest px-1">Past Events</h3>
                    {categorizedEvents.past.length > 0 ? (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 opacity-75 grayscale-[0.3]">
                        {categorizedEvents.past.map(ev => (
                          <EventManagementCard 
                            key={ev.id}
                            event={ev}
                            isSelected={selectedEventIds.includes(ev.id)}
                            isPast
                            onToggleSelect={() => {
                              setSelectedEventIds(prev => 
                                prev.includes(ev.id) ? prev.filter(id => id !== ev.id) : [...prev, ev.id]
                              );
                            }}
                            onEdit={() => {
                              setEditingEvent(ev);
                              setIsEventModalOpen(true);
                            }}
                          />
                        ))}
                      </div>
                    ) : (
                      <div className="py-8 text-center">
                        <p className="text-sm text-gray-400">No past events found.</p>
                      </div>
                    )}
                  </section>
                </div>
              </div>

              {/* Legends Section */}
              <div className="bg-white rounded-3xl p-8 shadow-sm border border-gray-100">
                <div className="flex items-center gap-4 mb-8">
                  <div className="p-3 rounded-2xl bg-blue-50 text-brand-navy">
                    <SettingsIcon className="w-6 h-6" />
                  </div>
                  <h2 className="text-2xl font-bold">App Legend</h2>
                </div>

                <div className="space-y-8">
                  <div className="pt-0">
                    <div className="space-y-4">
                      <div className="flex items-start gap-4">
                        <div className="w-3 h-3 rounded-full bg-brand-orange mt-1.5 shrink-0"></div>
                        <div>
                          <p className="font-bold text-sm">Week One / Week Two</p>
                          <p className="text-xs text-gray-500">Teacher-Mentors often have alternating block schedules. Each member's individual anchor date helps the app know which schedule to apply for any future date.</p>
                        </div>
                      </div>
                      <div className="flex items-start gap-4">
                        <div className="w-3 h-3 rounded-full bg-green-500 mt-1.5 shrink-0"></div>
                        <div>
                          <p className="font-bold text-sm">Perfect Sync</p>
                          <p className="text-xs text-gray-500">Dates where EVERY selected member has an overlapping available window. Priority for group meetings.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {/* Deletion Confirmation Modal */}
        <AnimatePresence>
          {profileToDelete && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setProfileToDelete(null)}
                className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl p-8 text-center"
              >
                <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Trash2 className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold text-brand-navy mb-2">Delete Profile?</h3>
                <p className="text-gray-500 mb-8">
                  Are you sure you want to delete <span className="font-bold text-gray-900">{profileToDelete.name}'s</span> profile? This action cannot be undone.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => setProfileToDelete(null)}
                    className="px-6 py-3 rounded-xl font-bold text-gray-400 hover:bg-gray-50 transition-all font-sans"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={confirmDeleteProfile}
                    className="px-6 py-3 rounded-xl font-bold bg-red-500 text-white shadow-lg shadow-red-200 hover:bg-red-600 active:scale-95 transition-all font-sans"
                  >
                    Yes, Delete
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {isDeletingBulk && (
            <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsDeletingBulk(false)}
                className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative bg-white rounded-[2rem] p-8 max-w-sm w-full shadow-2xl text-center"
              >
                <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mx-auto mb-6 text-2xl">
                  🗑️
                </div>
                <h3 className="text-xl font-bold text-gray-900 mb-2">Cancel {selectedEventIds.length} Events?</h3>
                <p className="text-gray-500 mb-8">This will permanently remove the record of these planning contexts. This action cannot be undone.</p>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsDeletingBulk(false)}
                    className="flex-1 px-6 py-3 rounded-xl font-bold text-gray-500 hover:bg-gray-50 transition-all border border-gray-100"
                  >
                    Keep Them
                  </button>
                  <button 
                    onClick={handleBulkDeleteEvents}
                    className="flex-1 px-6 py-3 rounded-xl font-bold bg-red-500 text-white hover:bg-red-600 transition-all shadow-lg shadow-red-200"
                  >
                    Cancel All
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {eventToDelete && (
            <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setEventToDelete(null)}
                className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative w-full max-w-md bg-white rounded-[2rem] shadow-2xl p-8 text-center"
              >
                <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mx-auto mb-6">
                  <Trash2 className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold text-brand-navy mb-2">Delete Event?</h3>
                <p className="text-gray-500 mb-8">
                  Are you sure you want to delete the event <span className="font-bold text-gray-900">{eventToDelete.title}</span>? All participants and planning data will be lost.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button 
                    onClick={() => setEventToDelete(null)}
                    className="px-6 py-3 rounded-xl font-bold text-gray-400 hover:bg-gray-100 transition-all font-sans"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={confirmDeleteEvent}
                    className="px-6 py-3 rounded-xl font-bold bg-red-500 text-white shadow-lg shadow-red-200 hover:bg-red-600 active:scale-95 transition-all font-sans"
                  >
                    Yes, Delete
                  </button>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
        {/* Event Modal */}
        <AnimatePresence>
          {isEventModalOpen && (
            <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                onClick={() => setIsEventModalOpen(false)}
                className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm"
              />
              <motion.div 
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                className="relative w-full max-w-2xl bg-white rounded-[2rem] shadow-2xl overflow-hidden flex flex-col"
              >
                <div className="p-6 bg-brand-navy text-white flex justify-between items-center">
                  <h2 className="text-2xl font-bold flex items-center gap-3">
                    <CalendarIcon className="w-6 h-6 text-brand-orange" />
                    New Event
                  </h2>
                  <button onClick={() => setIsEventModalOpen(false)} className="p-2 hover:bg-white/10 rounded-full transition-all">
                    <X className="w-6 h-6" />
                  </button>
                </div>

                <div className="p-8 space-y-8 overflow-y-auto max-h-[80vh]">
                  {eventError && (
                    <motion.div 
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm font-bold flex items-center gap-2"
                    >
                      <X className="w-4 h-4" />
                      {eventError}
                    </motion.div>
                  )}
                  <div className="space-y-4">
                    <div className="space-y-2">
                       <label className="text-xs font-bold uppercase text-gray-500 tracking-wider">Event Title</label>
                       <input 
                         type="text"
                         placeholder="e.g. Fall Kickoff Celebration"
                         className="w-full bg-gray-50 border-gray-100 border rounded-xl px-4 py-3 font-bold focus:ring-2 focus:ring-brand-orange outline-none"
                         value={editingEvent.title}
                         onChange={e => setEditingEvent({ ...editingEvent, title: e.target.value })}
                       />
                    </div>

                    <div className="space-y-3">
                       <label className="text-xs font-bold uppercase text-gray-500 tracking-wider">
                         Event Date
                       </label>
                       <div className="flex gap-2">
                         <input 
                           type="date"
                           className="flex-1 bg-gray-50 border-gray-100 border rounded-xl px-4 py-2 text-sm font-bold outline-none"
                           value={editingEvent.eventDates?.[0] || ''}
                           onChange={e => {
                             const dateValue = e.target.value;
                             
                             // Auto-propose planning end date to day before the event date
                             let planningUpdate = {};
                             if (dateValue) {
                               const eventD = new Date(dateValue + 'T12:00:00');
                               eventD.setDate(eventD.getDate() - 1);
                               planningUpdate = { planningEndDate: eventD.toISOString().split('T')[0] };
                             }

                             setEditingEvent({ 
                               ...editingEvent, 
                               eventDates: dateValue ? [dateValue] : [],
                               ...planningUpdate
                             });
                           }}
                         />
                       </div>
                    </div>

                    <div className="p-6 bg-gray-50 rounded-2xl border border-gray-100 space-y-4">
                       <h4 className="font-bold text-brand-navy flex items-center gap-2">
                         <Clock className="w-4 h-4 text-brand-orange" />
                         Planning Window
                       </h4>
                       <p className="text-xs text-gray-500 italic">Select the range when you need to find sync for planning meetings leading up to the event.</p>
                       <div className="grid grid-cols-2 gap-4">
                         <div className="space-y-1">
                           <label className="text-[10px] font-bold text-gray-400 uppercase">Start Date</label>
                           <input 
                             type="date"
                             className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm font-bold outline-none"
                             value={editingEvent.planningStartDate}
                             onChange={e => setEditingEvent({ ...editingEvent, planningStartDate: e.target.value })}
                           />
                         </div>
                         <div className="space-y-1">
                           <label className="text-[10px] font-bold text-gray-400 uppercase">End Date</label>
                           <input 
                             type="date"
                             className="w-full bg-white border border-gray-200 rounded-lg px-3 py-2 text-sm font-bold outline-none"
                             value={editingEvent.planningEndDate}
                             onChange={e => setEditingEvent({ ...editingEvent, planningEndDate: e.target.value })}
                           />
                         </div>
                       </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 border-t border-gray-100 bg-gray-50 flex justify-between gap-3">
                  {editingEvent.id ? (
                    <button 
                      onClick={() => {
                        handleDeleteEvent(editingEvent.id!);
                        setIsEventModalOpen(false);
                      }}
                      className="px-6 py-2 rounded-xl text-red-500 font-bold hover:bg-red-50 transition-all flex items-center gap-2"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete Event
                    </button>
                  ) : <div></div>}
                  <div className="flex gap-3">
                    <button onClick={() => setIsEventModalOpen(false)} className="px-6 py-2 rounded-xl text-gray-400 font-bold hover:bg-gray-100 transition-all">Cancel</button>
                    <button 
                      onClick={handleSaveEvent} 
                      className="px-8 py-2 rounded-xl bg-brand-orange text-white font-bold shadow-lg hover:bg-orange-600 transition-all"
                    >
                      {editingEvent.id ? 'Save Changes' : 'Create Event'}
                    </button>
                  </div>
                </div>
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </main>

      {/* Profile Modal */}
      <AnimatePresence>
        {isProfileModalOpen && editingProfile && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsProfileModalOpen(false)}
              className="absolute inset-0 bg-brand-navy/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-4xl bg-white rounded-[2rem] shadow-2xl overflow-hidden max-h-[90vh] flex flex-col"
            >
              <div className="p-6 sm:p-8 bg-brand-navy text-white flex justify-between items-center">
                <div>
                  <h3 className="text-xl font-bold">{editingProfile.name ? 'Edit Profile' : 'New Employee Profile'}</h3>
                  <p className="text-xs text-blue-200">Define repeating 2-week availability</p>
                </div>
                <button onClick={() => setIsProfileModalOpen(false)} className="p-2 hover:bg-white/10 rounded-full">
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 sm:p-8 space-y-8">
                {profileError && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="p-4 bg-red-50 border border-red-100 rounded-xl text-red-600 text-sm font-bold flex items-center gap-2"
                  >
                    <X className="w-4 h-4" />
                    {profileError}
                  </motion.div>
                )}
                
                {/* Schedule Tabs */}
                <div className="flex gap-2 p-1 bg-gray-100 rounded-2xl">
                  <button 
                    onClick={() => setActiveEditingSchedule(1)}
                    className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all ${activeEditingSchedule === 1 ? 'bg-white shadow-sm text-brand-navy' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    Schedule One (Base)
                  </button>
                  <button 
                    onClick={() => {
                      if (!editingProfile.hasScheduleTwo) {
                        setEditingProfile({
                          ...editingProfile,
                          hasScheduleTwo: true,
                          scheduleTwo: {
                            startDate: getSundays()[1], // Default to next Sunday
                            availability: JSON.parse(JSON.stringify(editingProfile.availability)) // Copy current as base
                          }
                        });
                      }
                      setActiveEditingSchedule(2);
                    }}
                    className={`flex-1 py-3 text-sm font-bold rounded-xl transition-all ${activeEditingSchedule === 2 ? 'bg-white shadow-sm text-brand-navy' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    Schedule Two {editingProfile.hasScheduleTwo ? '' : '(Add)'}
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 p-6 bg-gray-50 rounded-2xl border border-gray-100">
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-wider text-gray-500 px-1">Member Name</label>
                    <input 
                      type="text"
                      placeholder="e.g. Anyea"
                      className="w-full bg-white border-gray-200 border rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-orange outline-none"
                      value={editingProfile.name}
                      onChange={(e) => setEditingProfile({ ...editingProfile, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-bold uppercase tracking-wider text-gray-500 px-1">
                      {activeEditingSchedule === 1 ? 'Schedule One Start Date' : 'Schedule Two Transitions On'}
                    </label>
                    <select
                      className="w-full bg-white border-gray-200 border rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-orange outline-none bg-none appearance-none cursor-pointer font-bold"
                      value={activeEditingSchedule === 1 ? (editingProfile.startDate || getSundays()[0]) : (editingProfile.scheduleTwo?.startDate || getSundays()[1])} 
                      onChange={(e) => {
                        if (activeEditingSchedule === 1) {
                          setEditingProfile({ ...editingProfile, startDate: e.target.value });
                        } else {
                          setEditingProfile({ 
                            ...editingProfile, 
                            scheduleTwo: { 
                              ...editingProfile.scheduleTwo!, 
                              startDate: e.target.value 
                            } 
                          });
                        }
                      }}
                    >
                      {getSundays().map(sunday => {
                        const d = new Date(sunday + 'T12:00:00');
                        return (
                          <option key={sunday} value={sunday}>
                            {d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
                          </option>
                        );
                      })}
                    </select>
                    <p className="text-[10px] text-gray-400 px-1 italic">
                      {activeEditingSchedule === 1 
                        ? 'The Sunday that marks the start of this member\'s repeating 2-week cycle.' 
                        : 'On this date, Schedule Two will permanently replace Schedule One for all future comparisons.'}
                    </p>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex items-center gap-3">
                    <h4 className="font-bold text-gray-900">
                      {activeEditingSchedule === 1 ? 'Schedule One' : 'Schedule Two'} Availability
                    </h4>
                    {activeEditingSchedule === 2 && (
                      <button 
                        onClick={() => {
                          setEditingProfile({ ...editingProfile, hasScheduleTwo: false, scheduleTwo: undefined });
                          setActiveEditingSchedule(1);
                        }}
                        className="text-xs font-bold text-red-500 hover:underline"
                      >
                        Remove Schedule Two
                      </button>
                    )}
                    <div className="h-px flex-1 bg-gray-100"></div>
                  </div>
                  
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
                    <WeekScheduleEditor 
                      title="Week One" 
                      subtitle="Schedule"
                      schedule={activeEditingSchedule === 1 ? editingProfile.availability.weekA : editingProfile.scheduleTwo!.availability.weekA} 
                      onChange={(s) => {
                        if (activeEditingSchedule === 1) {
                          setEditingProfile({
                            ...editingProfile,
                            availability: { ...editingProfile.availability, weekA: s }
                          });
                        } else {
                          setEditingProfile({
                            ...editingProfile,
                            scheduleTwo: {
                              ...editingProfile.scheduleTwo!,
                              availability: { ...editingProfile.scheduleTwo!.availability, weekA: s }
                            }
                          });
                        }
                      }} 
                    />
                    <WeekScheduleEditor 
                      title="Week Two" 
                      subtitle="Schedule"
                      schedule={activeEditingSchedule === 1 ? editingProfile.availability.weekB : editingProfile.scheduleTwo!.availability.weekB} 
                      onChange={(s) => {
                        if (activeEditingSchedule === 1) {
                          setEditingProfile({
                            ...editingProfile,
                            availability: { ...editingProfile.availability, weekB: s }
                          });
                        } else {
                          setEditingProfile({
                            ...editingProfile,
                            scheduleTwo: {
                              ...editingProfile.scheduleTwo!,
                              availability: { ...editingProfile.scheduleTwo!.availability, weekB: s }
                            }
                          });
                        }
                      }} 
                    />
                  </div>
                </div>
              </div>

              <div className="p-6 bg-gray-50 border-t border-gray-100 flex justify-between items-center gap-3">
                <button 
                  type="button"
                  onClick={() => {
                    handleDeleteProfile(editingProfile.id);
                    setIsProfileModalOpen(false);
                  }}
                  className="px-4 py-2 text-sm font-bold text-red-500 hover:bg-red-50 rounded-xl transition-all flex items-center gap-2"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete Member
                </button>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setIsProfileModalOpen(false)}
                    className="px-6 py-2.5 rounded-xl font-bold text-gray-500 hover:bg-gray-100 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    onClick={() => handleSaveProfile(editingProfile)}
                    className="px-8 py-2.5 rounded-xl font-bold bg-brand-orange text-white shadow-sm hover:bg-orange-600 transition-all flex items-center gap-2"
                  >
                    <Save className="w-5 h-5" />
                    Save Member
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Sub-Components ---

function TabButton({ active, onClick, children, icon }: { active: boolean; onClick: () => void; children: React.ReactNode; icon: React.ReactNode }) {
  return (
    <button 
      onClick={onClick}
      className={`px-4 py-2 rounded-lg text-sm font-bold flex items-center gap-2 transition-all ${
        active 
          ? 'bg-white text-brand-navy shadow-sm' 
          : 'text-white/70 hover:text-white hover:bg-white/5'
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

interface ProfileCardProps {
  key?: React.Key;
  profile: Profile;
  onEdit: () => void;
  onDelete: () => void;
}

function ProfileCard({ profile, onEdit, onDelete }: ProfileCardProps): React.JSX.Element {
  const anchorDateObj = new Date(profile.startDate + 'T12:00:00');
  
  return (
    <div className="bg-white rounded-3xl shadow-sm border border-gray-100 overflow-hidden group hover:shadow-md transition-all">
      <div className="p-6">
        <div className="flex justify-between items-start mb-4">
          <div className="flex flex-col gap-1">
            <div className="w-12 h-12 rounded-2xl bg-brand-orange/10 flex items-center justify-center text-brand-orange">
               <Users className="w-6 h-6" />
            </div>
            <div className="mt-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest leading-none">
              Starts: {anchorDateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
            </div>
          </div>
          <div className="flex items-start gap-1 relative z-20">
            <button 
              onClick={(e) => {
                e.stopPropagation();
                onEdit();
              }} 
              className="p-3 text-gray-400 hover:text-brand-navy hover:bg-gray-50 rounded-xl transition-all"
            >
              <Edit2 className="w-4 h-4" />
            </button>
            <button 
              onClick={(e) => {
                e.stopPropagation();
                onDelete();
              }} 
              className="p-3 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-xl font-bold text-gray-900">{profile.name}</h3>
          {profile.hasScheduleTwo && (
            <span className="px-2 py-0.5 bg-blue-50 text-blue-600 text-[9px] font-bold rounded-md border border-blue-100">
              MULTI-SCHEDULE
            </span>
          )}
        </div>
        
        {profile.hasScheduleTwo && (
          <div className="mb-4 p-2 bg-blue-50/30 rounded-xl border border-blue-100/50">
             <p className="text-[10px] text-blue-600 font-bold uppercase flex items-center gap-1">
               <Clock className="w-3 h-3" />
               Transitions {new Date(profile.scheduleTwo!.startDate + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
             </p>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
           <div className="bg-gray-50 p-2 rounded-xl text-center">
              <p className="text-[10px] font-bold text-gray-400 uppercase">Week One Active</p>
              <p className="text-sm font-bold text-brand-navy">{Object.values(profile.availability.weekA).filter(slots => slots.length > 0).length} Days</p>
           </div>
           <div className="bg-gray-50 p-2 rounded-xl text-center">
              <p className="text-[10px] font-bold text-gray-400 uppercase">Week Two Active</p>
              <p className="text-sm font-bold text-brand-navy">{Object.values(profile.availability.weekB).filter(slots => slots.length > 0).length} Days</p>
           </div>
        </div>
      </div>
      <button 
        onClick={onEdit}
        className="w-full bg-gray-50 py-3 text-xs font-bold text-gray-500 hover:bg-brand-navy hover:text-white transition-all flex items-center justify-center gap-2"
      >
        View Detailed Schedule
        <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function WeekScheduleEditor({ title, subtitle, schedule, onChange }: { title: string; subtitle: string; schedule: DailySchedule; onChange: (s: DailySchedule) => void }) {
  return (
    <div className="space-y-4">
      <div>
        <h5 className="font-bold text-brand-navy">{title}</h5>
        <p className="text-xs text-gray-400 font-medium">{subtitle}</p>
      </div>
      <div className="space-y-3">
        {DAYS.map(day => {
          const slots = schedule[day.value] || [];
          const isActive = slots.length > 0;
          
          return (
            <div key={day.value} className={`p-4 rounded-2xl border transition-all ${isActive ? 'bg-white border-brand-orange/30 shadow-sm' : 'bg-gray-50/50 border-gray-100'}`}>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <div 
                      onClick={() => {
                          const newSched = { ...schedule };
                          if (isActive) {
                            newSched[day.value] = [];
                          } else {
                            newSched[day.value] = [{ start: '09:00', end: '17:00' }];
                          }
                          onChange(newSched);
                      }}
                      className={`w-6 h-6 rounded-full border-2 flex items-center justify-center cursor-pointer transition-all ${isActive ? 'bg-brand-orange border-brand-orange text-white' : 'border-gray-300 bg-white'}`}
                    >
                      {isActive && <CheckCircle2 className="w-4 h-4" />}
                    </div>
                    <span className={`font-bold ${isActive ? 'text-gray-900' : 'text-gray-400'}`}>{day.label}</span>
                  </div>

                  {!isActive && (
                    <span className="text-[10px] font-bold text-gray-300 uppercase tracking-widest italic">Unavailable</span>
                  )}
                  
                  {isActive && (
                    <button 
                      onClick={() => {
                        const newSched = { ...schedule };
                        newSched[day.value] = [...slots, { start: '09:00', end: '17:00' }];
                        onChange(newSched);
                      }}
                      className="text-[10px] font-bold text-brand-orange uppercase hover:underline"
                    >
                      + Add Slot
                    </button>
                  )}
                </div>

                {isActive && (
                  <div className="space-y-2">
                    {slots.map((slot, index) => (
                      <div key={index} className="flex items-center gap-2 bg-gray-100 p-1 pl-2 rounded-xl">
                        <input 
                          type="time" 
                          className="bg-transparent border-none text-xs font-bold px-1 focus:ring-0" 
                          value={slot.start}
                          onChange={(e) => {
                            const newSlots = [...slots];
                            newSlots[index] = { ...slot, start: e.target.value };
                            onChange({ ...schedule, [day.value]: newSlots });
                          }}
                        />
                        <span className="text-gray-400 font-bold px-1">-</span>
                        <input 
                          type="time" 
                          className="bg-transparent border-none text-xs font-bold px-1 focus:ring-0" 
                          value={slot.end}
                          onChange={(e) => {
                            const newSlots = [...slots];
                            newSlots[index] = { ...slot, end: e.target.value };
                            onChange({ ...schedule, [day.value]: newSlots });
                          }}
                        />
                        {slots.length > 1 && (
                          <button 
                            onClick={() => {
                              const newSlots = slots.filter((_, i) => i !== index);
                              onChange({ ...schedule, [day.value]: newSlots });
                            }}
                            className="p-1 hover:bg-gray-200 rounded-lg text-gray-400 transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface ResultCardProps {
  key?: React.Key;
  result: SyncResult;
  profiles: Profile[];
  totalSelected?: number;
}

function ResultCard({ result, profiles, totalSelected }: ResultCardProps): React.JSX.Element {
  const isFull = result.matchType === 'full';
  const displayDate = result.date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const [dayName, ...dateParts] = displayDate.split(', ');
  
  return (
    <motion.div 
      whileHover={{ y: -4 }}
      className={`bg-white rounded-3xl shadow-sm border overflow-hidden p-6 ${isFull ? 'border-brand-orange/40 ring-1 ring-brand-orange/10' : 'border-gray-100'}`}
    >
      <div className="flex justify-between items-start mb-6">
        <div>
           <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest mb-1">Group Sync</p>
           <h3 className="text-xl font-extrabold text-brand-navy leading-tight">{dayName}</h3>
           <p className="text-sm font-medium text-gray-500">{dateParts.join(', ')}</p>
        </div>
        <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${isFull ? 'bg-orange-500 text-white shadow-sm' : 'bg-brand-navy text-white opacity-80'}`}>
           {isFull ? 'Everyone Free' : `${result.availableMembers.length} of ${totalSelected} Available`}
        </div>
      </div>

      {result.overlapRanges.length > 0 ? (
        <div className="space-y-3 mb-6">
          {result.overlapRanges.map((range, i) => (
            <div key={i} className="bg-gray-50 rounded-2xl p-4 border border-gray-100">
               <div className="flex items-center gap-3 text-brand-navy">
                  <Clock className="w-5 h-5 text-brand-orange" />
                  <div className="font-bold flex items-baseline gap-1">
                     <span className="text-lg">{formatTime(range.start)}</span>
                     <span className="text-xs text-gray-400">to</span>
                     <span className="text-lg">{formatTime(range.end)}</span>
                  </div>
               </div>
               <p className="text-[10px] font-bold text-gray-400 mt-2 uppercase">Common Availability Window</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-red-50 rounded-2xl p-4 mb-6 border border-red-100 text-red-500">
           <p className="text-xs font-bold uppercase flex items-center gap-2">
             <X className="w-4 h-4" />
             No Overlap Window
           </p>
           <p className="text-[10px] opacity-80 mt-1 italic">Members are free at different times.</p>
        </div>
      )}

      <div className="space-y-3">
        <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">{isFull ? 'Participants' : 'Available Now'}</p>
        <div className="flex flex-wrap gap-2">
           {result.availableMembers.map(id => {
             const p = profiles.find(profile => profile.id === id);
             return (
               <span key={id} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-50 text-brand-navy text-[11px] font-bold border border-blue-100 shadow-sm">
                  <div className="w-1.5 h-1.5 rounded-full bg-brand-orange"></div>
                  {p?.name.split(' ')[0] || 'Member'}
               </span>
             );
           })}
        </div>
      </div>
    </motion.div>
  );
}

interface EventManagementCardProps {
  key?: React.Key;
  event: AppEvent;
  isSelected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  isPast?: boolean;
}

function EventManagementCard({ event, isSelected, onToggleSelect, onEdit, isPast }: EventManagementCardProps): React.JSX.Element {
  const firstDateStr = event.eventDates?.[0] || event.planningStartDate;
  const d = new Date(firstDateStr + 'T12:00:00');
  
  return (
    <div 
      className={`relative p-5 rounded-2xl border transition-all ${
        isSelected 
          ? 'bg-orange-50 border-brand-orange ring-1 ring-brand-orange/20' 
          : 'bg-white border-gray-100 hover:border-gray-200 shadow-sm'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button 
            type="button"
            onClick={onToggleSelect}
            className={`mt-1 w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${
              isSelected ? 'bg-brand-orange border-brand-orange text-white' : 'border-gray-300 bg-white'
            }`}
          >
            {isSelected && <CheckCircle2 className="w-4 h-4" />}
          </button>
          
          <div onClick={onToggleSelect} className="cursor-pointer">
            <h4 className="font-bold text-gray-900 leading-tight mb-1">{event.title}</h4>
            <div className="flex items-center gap-2 text-[10px] font-bold text-gray-400 uppercase tracking-widest">
              <span>{d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              {isPast && <span className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-500 lowercase tracking-normal">Past</span>}
            </div>
          </div>
        </div>

        <button 
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
          className="p-2 rounded-xl text-gray-400 hover:text-brand-navy hover:bg-gray-50 transition-all font-sans"
        >
          <Edit2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

function MenuIcon({ activeTab, setActiveTab, setEditingEvent, setIsEventModalOpen }: { 
  activeTab: string; 
  setActiveTab: (t: any) => void;
  setEditingEvent: (e: any) => void;
  setIsEventModalOpen: (o: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  
  return (
    <div className="relative">
      <button onClick={() => setIsOpen(!isOpen)} className="p-2 text-white">
        {isOpen ? <X /> : <ChevronRight className="rotate-90" />}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="absolute right-0 mt-2 w-48 bg-white rounded-2xl shadow-xl border border-gray-100 p-2 z-[60]"
          >
              {[
                { id: 'new-event', label: 'New Event', icon: <Plus className="w-4 h-4 text-brand-orange" />, action: () => {
                  setEditingEvent({
                    title: '',
                    eventDates: [''],
                    planningStartDate: new Date().toISOString().split('T')[0],
                    planningEndDate: ''
                  });
                  setIsEventModalOpen(true);
                }},
                { id: 'sync', label: 'Calendar Sync', icon: <CalendarIcon className="w-4 h-4" /> },
                { id: 'members', label: 'Members', icon: <Users className="w-4 h-4" /> },
                { id: 'settings', label: 'Settings', icon: <SettingsIcon className="w-4 h-4" /> },
              ].map(tab => (
                <button
                  key={tab.id}
                  onClick={() => {
                    if ('action' in tab && tab.action) {
                      tab.action();
                    } else {
                      setActiveTab(tab.id as any);
                    }
                    setIsOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
                    activeTab === tab.id 
                      ? 'bg-blue-50 text-brand-navy' 
                      : 'text-gray-600 hover:bg-gray-50'
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}