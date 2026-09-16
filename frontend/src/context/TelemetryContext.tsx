import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  SensorDataPacket,
  RiskEvaluation,
  ConveyorSystem,
  AlertItem,
  EventItem,
  DemoScenario,
  DeviceInfo,
  VisionInspection,
  HardwareMode,
  IncidentItem,
  SOSMessageItem,
  CompanyInfo,
  OnboardingData
} from '@shared/types';

interface TelemetryContextType {
  packet: SensorDataPacket | null;
  risk: RiskEvaluation | null;
  conveyor: ConveyorSystem;
  alerts: AlertItem[];
  events: EventItem[];
  devices: DeviceInfo[];
  history: SensorDataPacket[];
  latestVision?: VisionInspection;
  currentScenario: DemoScenario;
  incidents: IncidentItem[];
  sosMessages: SOSMessageItem[];
  company: CompanyInfo | null;
  isSocketConnected: boolean;      // WebSocket server reachable
  hardwareMode: HardwareMode;      // DISCONNECTED | SIMULATION | LIVE_HARDWARE
  isHardwareConnected: boolean;    // true only for LIVE_HARDWARE
  localSafetyActive: boolean;
  setScenario: (scenario: DemoScenario) => void;
  sendMotorCommand: (action: 'START' | 'STOP' | 'EMERGENCY_STOP') => void;
  acknowledgeAlert: (id: string) => void;
  clearAlerts: () => void;
  triggerVisionScan: (condition?: string, severity?: string) => Promise<void>;
  enableSimulation: () => void;
  disableSimulation: () => void;
  updateIncidentStatus: (id: string, status: IncidentItem['status'], notes?: string) => Promise<void>;
  triggerSos: (condition?: string) => Promise<void>;
  submitOnboarding: (data: OnboardingData) => Promise<void>;
}

/** A completely idle conveyor – no telemetry */
const disconnectedConveyor: ConveyorSystem = {
  id: 'CONV-01',
  name: 'Main Shaft Iron Ore Conveyor',
  location: 'Primary Crusher Feed Line – Shaft 4',
  status: 'STOPPED',
  healthPercent: 0,
  riskScore: 0,
  riskLevel: 'NORMAL',
  beltSpeedMps: 0,
  motorCurrentA: 0,
  vibrationRmsG: 0,
  alignmentStatus: 'ALIGNED',
  activeAlertsCount: 0,
  uptimePercent: 0,
  lastInspectionDate: new Date(Date.now() - 86400000 * 2).toISOString()
};

const TelemetryContext = createContext<TelemetryContextType | undefined>(undefined);

export const TelemetryProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [packet, setPacket] = useState<SensorDataPacket | null>(null);
  const [risk, setRisk] = useState<RiskEvaluation | null>(null);
  const [conveyor, setConveyor] = useState<ConveyorSystem>(disconnectedConveyor);
  const [alerts, setAlerts] = useState<AlertItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [history, setHistory] = useState<SensorDataPacket[]>([]);
  const [latestVision, setLatestVision] = useState<VisionInspection | undefined>(undefined);
  const [currentScenario, setCurrentScenario] = useState<DemoScenario>('NORMAL');
  const [incidents, setIncidents] = useState<IncidentItem[]>([]);
  const [sosMessages, setSosMessages] = useState<SOSMessageItem[]>([]);
  const [company, setCompany] = useState<CompanyInfo | null>(null);

  // Connection state
  const [isSocketConnected, setIsSocketConnected] = useState<boolean>(false);
  const [hardwareMode, setHardwareMode] = useState<HardwareMode>('DISCONNECTED');
  const [isHardwareConnected, setIsHardwareConnected] = useState<boolean>(false);
  const [localSafetyActive, setLocalSafetyActive] = useState<boolean>(true);

  const [socket, setSocket] = useState<Socket | null>(null);

  const BACKEND_URL = import.meta.env.VITE_API_URL || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.hostname}:4000` : 'http://localhost:4000');

  useEffect(() => {
    const s = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 10,
      reconnectionDelay: 1500
    });

    s.on('connect', () => {
      setIsSocketConnected(true);
    });

    s.on('disconnect', () => {
      setIsSocketConnected(false);
      setHardwareMode('DISCONNECTED');
      setIsHardwareConnected(false);
    });

    // Full snapshot on first connect
    s.on('telemetry_init', (data) => {
      if (data.packet) setPacket(data.packet);
      if (data.risk) setRisk(data.risk);
      if (data.conveyor) setConveyor(data.conveyor);
      if (data.currentScenario) setCurrentScenario(data.currentScenario);
      if (data.devices) setDevices(data.devices);
      if (data.localSafetyActive !== undefined) setLocalSafetyActive(data.localSafetyActive);
      if (data.hardwareMode) setHardwareMode(data.hardwareMode);
      setIsHardwareConnected(!!data.isHardwareConnected);
    });

    // Real-time telemetry tick
    s.on('telemetry_tick', (data) => {
      if (data.packet) {
        setPacket(data.packet);
        setHistory(prev => [...prev.slice(-49), data.packet]);
      }
      if (data.risk) setRisk(data.risk);
      if (data.conveyor) setConveyor(data.conveyor);
      if (data.newAlerts && data.newAlerts.length > 0) {
        setAlerts(prev => [...data.newAlerts, ...prev].slice(0, 50));
      }
      if (data.newEvents && data.newEvents.length > 0) {
        setEvents(prev => [...data.newEvents, ...prev].slice(0, 100));
      }
      if (data.hardwareMode) setHardwareMode(data.hardwareMode);
    });

    // Hardware mode change
    s.on('hardware_mode_changed', (data) => {
      if (data.hardwareMode) setHardwareMode(data.hardwareMode);
      setIsHardwareConnected(!!data.isHardwareConnected);
      if (data.devices) setDevices(data.devices);
      if (data.conveyor) setConveyor(data.conveyor);
    });

    s.on('scenario_updated', ({ scenario }) => setCurrentScenario(scenario));
    s.on('conveyor_updated', ({ conveyor }) => setConveyor(conveyor));
    s.on('alerts_updated', ({ alerts }) => setAlerts(alerts));
    s.on('vision_updated', ({ inspection }) => setLatestVision(inspection));
    s.on('incidents_updated', ({ incidents }) => setIncidents(incidents));
    s.on('sos_updated', ({ sosMessages }) => setSosMessages(sosMessages));

    setSocket(s);

    // Hydrate state from backend APIs
    fetch(`${BACKEND_URL}/api/devices`).then(res => res.json()).then(data => { if (data.devices) setDevices(data.devices); }).catch(() => {});
    fetch(`${BACKEND_URL}/api/alerts`).then(res => res.json()).then(data => { if (data.alerts) setAlerts(data.alerts); }).catch(() => {});
    fetch(`${BACKEND_URL}/api/events`).then(res => res.json()).then(data => { if (data.events) setEvents(data.events); }).catch(() => {});
    fetch(`${BACKEND_URL}/api/incidents`).then(res => res.json()).then(data => { if (data.incidents) setIncidents(data.incidents); }).catch(() => {});
    fetch(`${BACKEND_URL}/api/sos`).then(res => res.json()).then(data => { if (data.sosMessages) setSosMessages(data.sosMessages); }).catch(() => {});
    fetch(`${BACKEND_URL}/api/company`).then(res => res.json()).then(data => { if (data.company) setCompany(data.company); if (data.conveyor) setConveyor(data.conveyor); }).catch(() => {});

    fetch(`${BACKEND_URL}/api/hardware/status`)
      .then(res => res.json())
      .then(data => {
        setHardwareMode(data.hardwareMode);
        setIsHardwareConnected(!!data.isHardwareConnected);
        if (data.devices) setDevices(data.devices);
      })
      .catch(() => {});

    return () => { s.disconnect(); };
  }, []);

  const setScenario = useCallback((scenario: DemoScenario) => {
    setCurrentScenario(scenario);
    if (socket) socket.emit('set_scenario', scenario);
    fetch(`${BACKEND_URL}/api/demo/scenario`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario })
    })
      .then(res => res.json())
      .then(data => {
        if (data.conveyor) setConveyor(data.conveyor);
        if (data.incidents) setIncidents(data.incidents);
        if (data.sosMessages) setSosMessages(data.sosMessages);
      })
      .catch(() => {});
  }, [socket]);

  const sendMotorCommand = useCallback((action: 'START' | 'STOP' | 'EMERGENCY_STOP') => {
    const newStatus = action === 'START' ? 'RUNNING' : action === 'STOP' ? 'STOPPED' : 'EMERGENCY_STOP';
    
    // Immediate optimistic update so UI reflects the command instantly
    setConveyor(prev => ({
      ...prev,
      status: newStatus,
      beltSpeedMps: action === 'START' ? 1.5 : 0,
      motorCurrentA: action === 'START' ? 0.82 : 0,
      vibrationRmsG: action === 'START' ? 1.27 : 0
    }));

    if (socket) socket.emit('motor_control', { action });

    const ep = action === 'START' ? `${BACKEND_URL}/api/motor/start`
             : action === 'EMERGENCY_STOP' ? `${BACKEND_URL}/api/motor/emergency-stop`
             : `${BACKEND_URL}/api/motor/stop`;
    fetch(ep, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.conveyor) setConveyor(data.conveyor);
        if (data.hardwareMode) setHardwareMode(data.hardwareMode);
      })
      .catch(err => console.error('Motor command failed:', err));
  }, [socket]);

  const acknowledgeAlert = useCallback((id: string) => {
    setAlerts(prev => prev.map(a => (a.id === id ? { ...a, acknowledged: true, acknowledgedBy: 'Operator' } : a)));
    fetch(`${BACKEND_URL}/api/alerts/${id}/acknowledge`, { method: 'POST' }).catch(() => {});
  }, []);

  const clearAlerts = useCallback(() => {
    setAlerts([]);
    fetch(`${BACKEND_URL}/api/alerts/clear`, { method: 'POST' }).catch(() => {});
  }, []);

  const triggerVisionScan = useCallback(async (condition = 'TEAR', severity = 'HIGH') => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/vision/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition, severity })
      });
      const data = await res.json();
      if (data.inspection) setLatestVision(data.inspection);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const updateIncidentStatus = useCallback(async (id: string, status: IncidentItem['status'], notes?: string) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/incidents/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, resolutionNotes: notes })
      });
      const data = await res.json();
      if (data.incident) {
        setIncidents(prev => prev.map(i => i.id === id ? data.incident : i));
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  const triggerSos = useCallback(async (condition = 'MANUAL SOS TRIGGER') => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/sos/trigger`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ condition })
      });
      const data = await res.json();
      if (data.sosMessage) setSosMessages(prev => [data.sosMessage, ...prev]);
      if (data.incident) setIncidents(prev => [data.incident, ...prev]);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const submitOnboarding = useCallback(async (data: OnboardingData) => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/onboarding`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const result = await res.json();
      if (result.company) setCompany(result.company);
      if (result.conveyor) setConveyor(result.conveyor);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const enableSimulation = useCallback(() => {
    fetch(`${BACKEND_URL}/api/simulation/enable`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.hardwareMode) setHardwareMode(data.hardwareMode);
        if (socket) socket.emit('enable_simulation');
      })
      .catch(() => {});
  }, [socket]);

  const disableSimulation = useCallback(() => {
    fetch(`${BACKEND_URL}/api/simulation/disable`, { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (data.hardwareMode) {
          setHardwareMode(data.hardwareMode);
          setConveyor(disconnectedConveyor);
          setPacket(null);
          setRisk(null);
        }
        if (socket) socket.emit('disable_simulation');
      })
      .catch(() => {});
  }, [socket]);

  return (
    <TelemetryContext.Provider
      value={{
        packet,
        risk,
        conveyor,
        alerts,
        events,
        devices,
        history,
        latestVision,
        currentScenario,
        incidents,
        sosMessages,
        company,
        isSocketConnected,
        hardwareMode,
        isHardwareConnected,
        localSafetyActive,
        setScenario,
        sendMotorCommand,
        acknowledgeAlert,
        clearAlerts,
        triggerVisionScan,
        enableSimulation,
        disableSimulation,
        updateIncidentStatus,
        triggerSos,
        submitOnboarding
      }}
    >
      {children}
    </TelemetryContext.Provider>
  );
};

export const useTelemetry = () => {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error('useTelemetry must be used within TelemetryProvider');
  return ctx;
};
