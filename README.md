# Vincii Anunciação

Cliente VoIP da Vincii (o nome vem da obra de Leonardo da Vinci). App desktop (Windows, macOS e Linux) com várias linhas ao mesmo tempo, nos moldes do Linphone, na identidade visual da VINCII.

## Download

Instaladores para Windows, macOS (Apple Silicon e Intel) e Linux (AppImage e .deb) em
**[Releases](https://github.com/Vincii-Solucoes/vincii-anunciacao/releases/latest)**.

## Rodar e empacotar

```bash
npm install
npm run dev          # desenvolvimento (Vite + Electron)
npm start            # compila e abre o app
npm run dist:mac     # .dmg / .zip   (rodar no macOS)
npm run dist:win     # instalador NSIS (rodar no Windows)
npm run dist:linux   # AppImage e .deb (rodar no Linux)
npm run install:mac  # compila e instala em /Applications neste Mac
```

Cada instalador deve ser gerado no próprio sistema. Ao enviar uma tag `vX.Y.Z`, o GitHub Actions
(`.github/workflows/release.yml`) compila os três sistemas e publica o Release automaticamente.
`npm run web` abre só a interface no navegador em modo demonstração (sem SIP).

## Recursos

**Linhas**: várias contas SIP registradas ao mesmo tempo, cada uma via UDP, TCP ou TLS; proxy de saída; SRV DNS;
detecção de IP público via rport; keep-alive de NAT; reconexão automática; senhas no cofre do sistema (safeStorage).

**Chamadas**: recebe em todas as linhas simultaneamente; espera automática; mudo; DTMF (RFC 2833/4733 ou SIP INFO);
transferência direta e assistida (consulta ou entre duas chamadas); conferência local (mixagem no app);
desvio (sempre / se ocupado / se não atender); Não perturbe (global e por linha);
atendimento automático; tom de chamada brasileiro; histórico.

**Desktop**: ícone na bandeja (pisca ao tocar, menu com Não perturbe, iniciar com o sistema, sair);
fechar mantém rodando na bandeja; iniciar com o sistema e iniciar minimizado; abre com links `sip:`/`tel:`/`callto:`.

**Visual**: tema claro e escuro (segue o sistema ou escolha manual), barra de título integrada ao layout,
ícone próprio unindo o V da VINCII a um telefone (`npm run icons` regenera ícones do app e da bandeja).

**Áudio**: codecs por linha, com ordem de preferência — Opus, G.722 (HD), G.711 PCMA e PCMU e G.729; motor interno em 16 kHz; RTP simétrico, cancelamento de eco, supressão de ruído e controle de ganho.

## Segurança

- SIP via UDP só é aceito vindo do servidor/proxy da linha (bloqueia "chamadas fantasma" de scanners).
- Áudio (RTP) só é aceito da origem negociada no SDP ou do servidor SIP (evita injeção/sequestro de áudio).
- Transferências recebidas (REFER) só para destinos do próprio PBX (evita discagem forçada para fora).
- Senhas no cofre do sistema (safeStorage); logs de diagnóstico com credenciais ocultas, apagados após 14 dias.
- Electron isolado (contextIsolation, sandbox, CSP, sem webview/novas janelas), ponte IPC com validação de argumentos.
- App instalado recusa depuração remota/inspetor; fusíveis do Electron: sem RunAsNode, sem NODE_OPTIONS,
  sem --inspect, verificação de integridade do asar e carregamento só do asar.
- Links `sip:`/`tel:` apenas preenchem o discador — a ligação só sai com o clique do usuário.

## Arquitetura

- `electron/` — processo principal: janela, bandeja, inicialização, sockets UDP/TCP/TLS, criptografia.
- `src/sip/` — SIP.js com transporte nativo (`transport.js`, retransmissão UDP) e SDP RTP puro (`sdh.js`); lógica das chamadas em `phone.js`.
- `src/media/` — codec G.711, RTP/DTMF, AudioWorklet de mixagem (conferência e buffer de jitter).

## Pendências conhecidas

- Sem vídeo, chat/presença, SRTP/ZRTP e STUN/ICE para mídia.
- Instaladores sem assinatura digital: o macOS/Windows vão exibir alerta até assinar (certificado Developer ID / Authenticode).

## Licença

GPL-3.0-or-later (veja `LICENSE`). O codec G.729 usa o [bcg729](https://github.com/BelledonneCommunications/bcg729)
da Belledonne Communications (GPLv3), versão 1.1.1, cujo código-fonte está em `vendor/bcg729` e é compilado para
WebAssembly com `sh scripts/build-g729.sh` (requer Docker).
