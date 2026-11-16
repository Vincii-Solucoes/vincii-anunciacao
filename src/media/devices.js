// Escolha do dispositivo de áudio realmente usado.
// Windows tem dois padrões: o multimídia ("default", em geral as caixas de som) e o de comunicação
// ("communications", em geral o headset). Como Teams/Zoom, a voz da chamada usa o de comunicação;
// o toque usa o multimídia, para tocar alto.
export const IS_WINDOWS = (typeof window !== 'undefined' && window.vincii?.platform === 'win32') || /Windows/i.test(navigator.userAgent);

export const listDevices = () => navigator.mediaDevices.enumerateDevices().catch(() => []);

// kind: 'audioinput' | 'audiooutput'; chosen: id salvo ('' = automático); role: 'voice' | 'ring'
// Devolve o deviceId a usar ('' = padrão do sistema).
export function resolveDevice(devices, kind, chosen, role = 'voice') {
  const list = devices.filter((d) => d.kind === kind);
  if (chosen && list.some((d) => d.deviceId === chosen)) return chosen;
  if (role === 'voice' && IS_WINDOWS && list.some((d) => d.deviceId === 'communications')) return 'communications';
  return '';
}

// Nome do dispositivo que "automático" representa (para exibir nas Configurações).
export function autoLabel(devices, kind, role = 'voice') {
  const list = devices.filter((d) => d.kind === kind);
  const id = resolveDevice(devices, kind, '', role) || 'default';
  const d = list.find((x) => x.deviceId === id);
  const name = cleanLabel(d?.label);
  if (id === 'communications') return `Padrão de comunicação do Windows${name ? ` (${name})` : ''}`;
  return `Padrão do sistema${name ? ` (${name})` : ''}`;
}

export const cleanLabel = (l) => String(l || '').replace(/^(Default|Padrão|Communications|Comunicações)\s*-\s*/i, '').trim();
