# Donel Dev — o que mudou

## 0.3.2 — 28/07/2026

O primeiro teste numa máquina que não é a do autor rendeu três correções de
"funciona em qualquer ambiente":

- **Sessões abrem com o CLI instalado via npm.** Quem instalou o Claude Code
  com `npm i -g` tem um script (`claude.cmd`), não um executável — e o app não
  conseguia abri-lo: a sessão morria no nascimento, sem explicação. O app
  agora detecta o formato e abre pelo interpretador certo; havendo os dois,
  o executável de verdade tem preferência.
- **Falha ao abrir um terminal agora diz o motivo.** Comando que não existe,
  pasta de trabalho apagada ou o `node-pty` sem compilar apareciam como uma
  aba morta. A mensagem de erro aparece no próprio terminal, com o que
  conferir em cada caso.
- **"O que aparece como projeto" virou preferência.** Por padrão a sidebar
  continua mostrando só pastas com `.git/` ou `CLAUDE.md`; quem não organiza
  o disco por repositório pode trocar para "Todas as pastas" em Preferências
  — e a tela agora diz qual critério está ativo.
- **Instalação assistida pelo Claude Code** (repo público): clonou, abriu o
  `claude` na pasta e pediu "instala o app" — o passo a passo completo está
  no `CLAUDE.md`, incluindo os planos B de build.

## 0.3.1 — 28/07/2026

- **Tela preta ao clicar numa fase do mapa — corrigido.** Quando o manifesto
  de uma fase concluída listava os artefatos no formato de objeto nomeado
  (o formato que a Esteira realmente grava), abrir o painel de detalhes do nó
  derrubava a interface inteira. O leitor agora aceita os dois formatos e
  degrada com elegância diante de um manifesto de formato desconhecido.

## 0.3.0 — 27/07/2026

O **Modo Dev** chegou — e a primeira noite de uso real dele lapidou a tela
clássica também.

- **Modo Dev (alternável no topo).** Ligou, a tela se reorganiza para conduzir
  um trabalho da Esteira de ponta a ponta: a **porta de entrada** lista os
  cards do board, o **mapa do discovery** mostra cada marco com o estado real
  de cada fase (lido dos artefatos no disco do repositório), e clicar numa
  fase abre a sessão com o comando **já escrito no prompt — o Enter é sempre
  seu**; o app nunca envia nada em seu nome. Desligou, a tela de hoje volta
  como era.
- **Espelho do board.** Sobre o mapa, o Modo Dev anota o que o board sabe de
  cada card: coluna real, etiqueta de trava, PR vinculado e aprovação. Quando
  o disco e o board discordam sobre a fase, o marcador ⇄ aparece e um clique
  prepara a sessão de conciliação (também sem Enter automático). Tudo
  somente-leitura: o app nunca escreve no board.
- **"＋ Nova sessão" agora abre o painel de escolha** (modelo, esforço,
  projeto) em vez de disparar às cegas; o disparo rápido com a última
  configuração virou item do menu do mesmo botão. O painel tem botão de
  fechar, e funciona também no Modo Dev.
- **A linha de Modelo/Esforço acima do terminal saiu.** A leitura vive no
  rodapé, junto do **contexto real da sessão** (`modelo/esforço · ctx Nk`),
  atualizada pelo que acontece de verdade no terminal.
- **Foco no terminal**: barra superior mais baixa e as duas laterais
  recolhíveis por botão — dá para trabalhar com o terminal em tela quase
  cheia e trazer os painéis de volta quando precisar.
- **Ctrl+V colava duas vezes — corrigido.** O texto entrava em dobro porque a
  colagem do app convivia com a colagem nativa do navegador; agora só existe
  uma.
- **A caixa de digitação nunca mais cai fora da tela.** Um erro de layout
  fazia o terminal crescer além da janela e esconder o prompt do CLI; o
  terminal agora se ajusta ao espaço que existe.
- **Sessões abertas pelo app são sempre sessões-raiz do Claude Code.** Se o
  próprio Donel Dev tivesse sido aberto a partir de um terminal com o Claude
  rodando, as sessões herdavam marcas de "sessão filha" (transcript desligado,
  permissões herdadas). O app agora limpa essas marcas ao criar cada sessão.

## 0.2.0 — 26/07/2026

Faxina antes de abrir o Modo Dev. Nada muda no jeito de usar; o que muda é uma
lista que enganava e uma rede de segurança que estava furada.

- **A sessão que não existe mais desaparece da lista.** Antes, se você clicava
  numa sessão do grupo Favoritos e ela já tinha sido apagada do disco, o app
  tentava retomar, a aba nascia morta e a linha **continuava lá** — convidando
  ao mesmo clique inútil amanhã. Agora, quando a retomada falha, a linha sai da
  lista sozinha, sem aviso e sem perguntar, **inclusive se estava fixada**.
  Antes de apagar, o app confere que o arquivo da sessão realmente não existe
  mais — sessão que só falhou por outro motivo (cota, `claude` fora do PATH,
  você fechando a aba na hora) **não** é esquecida.
- **A bateria de testes automáticos voltou a valer em qualquer pasta.** Cinco
  testes falhavam sempre que a bateria rodava de uma cópia de trabalho paralela
  do projeto — e é assim que as entregas em lote são conferidas. Falhavam por
  erro do próprio teste, não do app: eles procuravam o projeto pelo nome fixo
  `donel-dev` e acabavam clicando na pasta errada. Efeito prático: o crivo de
  qualidade das entregas em lote estava parcialmente cego, e cinco vermelhos
  falsos podiam ser lidos como defeito novo. Agora o nome é calculado, há uma
  cerca automática que impede o erro de voltar, e a correção foi provada
  rodando a bateria **nos dois lugares**.

## 0.1.0 — 26/07/2026

Primeira versão compartilhada.

- **Várias sessões do Claude Code em abas**, cada uma rodando o `claude` de
  verdade — hooks, skills, MCPs e comandos funcionam sem adaptação.
- **Semáforo por sessão**: dá para ver de longe quem está trabalhando, quem
  terminou e quem está esperando uma resposta sua. Sessão aguardando permissão
  sobe para o topo da lista.
- **Painel de projetos**: aponte suas pastas de trabalho e o app lista os
  projetos e as sessões de cada um.
- **Sessões anteriores**: retomar de onde parou ou forkar a partir de um ponto.
- **Launcher**: escolha modelo, esforço e modo de permissões antes de subir a
  sessão.
- **Nomes de sessão**: renomeie pela aba (duplo-clique ou F2) ou use `/rename`
  dentro da sessão — o app acompanha e reflete na hora.
- **% de contexto consumido** na barra da sessão, para saber quando fazer
  handoff antes de a janela apertar.
- **Copiar e colar como num terminal moderno**: `Ctrl+C` com texto selecionado
  copia; **sem seleção, numa aba de sessão, não derruba mais a execução** (para
  interromper o modelo, `Esc`). Numa aba de terminal livre o `Ctrl+C` continua
  interrompendo o processo, como sempre. `Ctrl+V` cola texto em bloco único — e
  **cola print** direto na conversa quando há imagem no clipboard.
- **Favoritos com as sessões recentes**: favoritou um projeto, ele ganha um
  grupo no topo da sidebar com as **5 sessões mais recentes** + as que você
  **fixar**. Clicar foca a aba se já estiver aberta, ou retoma. Grupo
  colapsável, e o estado sobrevive a fechar o app. O app não reabre sessão
  sozinho — é acesso rápido, não restauração, e nada consome cota sem você
  pedir.
- **Perfis de conta**: mais de uma conta Claude na mesma máquina, isoladas por
  `CLAUDE_CONFIG_DIR`.
- Instalação **por usuário, sem admin**.
