#include <Wire.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <MPU6050.h>

MPU6050 mpu;

// ---------------- WiFi / Backend Config ----------------
const char* WIFI_SSID = "Aravindh_Hotspot";
const char* WIFI_PASS = "Qtransplant123";

// LAN IP of your host machine running conveyX backend port 4000
const char* API_URL   = "http://10.42.27.198:4000/api/ingest"; 

// ---------------- Pin Definitions ----------------
const int IR_TACHO_PIN     = 4;   // D4  - belt/motor RPM counting, interrupt-capable
const int IR_PARTICLE_PIN  = 35;  // D35 - repurposed from safety beam - particle counter
const int ACS712_PIN       = 34;  // D34 - current sensor, ADC1 pin
const int RELAY_PIN        = 27;  // D27 - HIGH = motor on, LOW = tripped
const int BUZZER_PIN       = 18;  // D18 - siren
const int BUTTON_PIN       = 32;  // D32 - hold-to-stop manual override

const int MOTOR_IN1        = 26;  // L298N direction pin 1
const int MOTOR_IN2        = 25;  // L298N direction pin 2
const int MOTOR_ENA        = 33;  // L298N PWM speed pin

// ---------------- Motor Speed ----------------
// 0-255 range. Lowered for slow belt movement so particle sensor can reliably detect.
int MOTOR_SPEED = 60;

const int PWM_CHANNEL = 0;
const int PWM_FREQ = 5000;
const int PWM_RES = 8; // 8-bit resolution -> 0-255 range

// ---------------- Sampling / Thresholds ----------------
volatile unsigned long pulseCount = 0;
unsigned long lastSampleTime = 0;
const unsigned long SAMPLE_INTERVAL = 500; // ms

const float ACS712_SENSITIVITY = 0.185; // V/A for 5A module
const float ACS712_ZERO_V = 2.5;        // calibrate at no-load
const float SAFE_CURRENT_MAX = 2.0;     // amps - hardware failsafe
const float VIBRATION_TRIP = 2.0;       // g's - hardware failsafe

// ---------------- Particle Counter ----------------
volatile unsigned long particleCount = 0;
volatile unsigned long lastParticleTime = 0;
const unsigned long PARTICLE_DEBOUNCE_MS = 200; // tune based on particle size + belt speed

void IRAM_ATTR irPulse() { pulseCount++; }

void IRAM_ATTR particleDetect() {
  unsigned long now = millis();
  if (now - lastParticleTime > PARTICLE_DEBOUNCE_MS) {
    particleCount++;
    lastParticleTime = now;
  }
}

void chirp(int times, int durationMs) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(durationMs);
    digitalWrite(BUZZER_PIN, LOW);
    delay(durationMs);
  }
}

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println("\nConnected. IP: " + WiFi.localIP().toString());
  chirp(2, 100); // double-chirp on connect
}

void setMotorSpeed(int speed) {
  speed = constrain(speed, 0, 255);
  digitalWrite(MOTOR_IN1, HIGH);
  digitalWrite(MOTOR_IN2, LOW);
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(MOTOR_ENA, speed);
#else
  ledcWrite(PWM_CHANNEL, speed);
#endif
}

void setup() {
  Serial.begin(115200);
  Wire.begin(); // SDA=21, SCL=22 default on ESP32
  mpu.initialize();

  pinMode(IR_TACHO_PIN, INPUT);
  pinMode(IR_PARTICLE_PIN, INPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  pinMode(MOTOR_IN1, OUTPUT);
  pinMode(MOTOR_IN2, OUTPUT);

  digitalWrite(RELAY_PIN, HIGH); // relay closed = motor powered
  digitalWrite(BUZZER_PIN, LOW);

  attachInterrupt(digitalPinToInterrupt(IR_TACHO_PIN), irPulse, FALLING);
  attachInterrupt(digitalPinToInterrupt(IR_PARTICLE_PIN), particleDetect, FALLING);

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcAttach(MOTOR_ENA, PWM_FREQ, PWM_RES);
#else
  ledcSetup(PWM_CHANNEL, PWM_FREQ, PWM_RES);
  ledcAttachPin(MOTOR_ENA, PWM_CHANNEL);
#endif

  setMotorSpeed(MOTOR_SPEED);

  connectWiFi();
}

float readVibrationRMS() {
  int16_t ax, ay, az;
  mpu.getAcceleration(&ax, &ay, &az);
  float gx = ax / 16384.0, gy = ay / 16384.0, gz = az / 16384.0;
  return sqrt(gx*gx + gy*gy + gz*gz);
}

float readCurrentAmps() {
  int raw = analogRead(ACS712_PIN);
  float voltage = (raw / 4095.0) * 3.3; // 12-bit ADC, 3.3V ref
  return (voltage - ACS712_ZERO_V) / ACS712_SENSITIVITY;
}

void checkButton() {
  if (digitalRead(BUTTON_PIN) == LOW) {
    digitalWrite(RELAY_PIN, LOW);   // held = motor off
    digitalWrite(BUZZER_PIN, HIGH);
  } else {
    digitalWrite(RELAY_PIN, HIGH);  // released = motor on
    digitalWrite(BUZZER_PIN, LOW);
  }
}

void sendReading(float vibration, float rpm, float current, unsigned long particles) {
  if (WiFi.status() != WL_CONNECTED) { connectWiFi(); return; }

  HTTPClient http;
  http.begin(API_URL);
  http.addHeader("Content-Type", "application/json");

  String payload = "{\"machine_id\":\"ESP32-CONVEY-01\",";
  payload += "\"vibration_rms\":" + String(vibration, 4) + ",";
  payload += "\"rpm\":" + String(rpm, 1) + ",";
  payload += "\"current_amps\":" + String(current, 3) + ",";
  payload += "\"particles\":" + String(particles) + "}";

  int code = http.POST(payload);
  Serial.println("POST status: " + String(code));
  http.end();
}

void loop() {
  checkButton();

  unsigned long now = millis();
  if (now - lastSampleTime >= SAMPLE_INTERVAL) {
    lastSampleTime = now;

    float vibration = readVibrationRMS();
    float current = readCurrentAmps();

    noInterrupts();
    unsigned long pulses = pulseCount;
    pulseCount = 0;
    unsigned long particlesThisCycle = particleCount;
    particleCount = 0;
    interrupts();

    float rpm = (pulses / (SAMPLE_INTERVAL / 1000.0)) * 60.0;

    // Hardware-level failsafe - independent of backend
    if (current > SAFE_CURRENT_MAX || vibration > VIBRATION_TRIP) {
      digitalWrite(RELAY_PIN, LOW);
      digitalWrite(BUZZER_PIN, HIGH);
      Serial.println("FAILSAFE TRIP - current or vibration exceeded threshold");
    }

    Serial.print("Vib: "); Serial.print(vibration, 3);
    Serial.print(" | RPM: "); Serial.print(rpm, 1);
    Serial.print(" | Current: "); Serial.print(current, 3);
    Serial.print(" | Particles: "); Serial.println(particlesThisCycle);

    sendReading(vibration, rpm, current, particlesThisCycle);
  }
}
