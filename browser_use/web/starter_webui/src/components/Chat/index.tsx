import { AgentScopeRuntimeWebUI, IAgentScopeRuntimeWebUIOptions } from '@agentscope-ai/chat';
import OptionsPanel from './OptionsPanel';
import { useMemo, useRef, useState } from 'react';
import sessionApi from './sessionApi';
import { useLocalStorageState } from 'ahooks';
import defaultConfig from './OptionsPanel/defaultConfig';
import Weather from '../Cards/Weather';
import BrowserViewer from '../BrowserViewer';

export default function () {
  const [optionsConfig, setOptionsConfig] = useLocalStorageState('agent-scope-runtime-webui-options', {
    defaultValue: defaultConfig,
    listenStorageChange: true,
  });

  // Sandbox URLs extracted from SSE message metadata
  const [vncUrl, setVncUrl] = useState<string | null>(null);
  // Use a ref so the parser closure always captures the latest setter without re-creating options
  const setVncUrlRef = useRef(setVncUrl);
  setVncUrlRef.current = setVncUrl;

  const options = useMemo(() => {
    const rightHeader = <OptionsPanel value={optionsConfig} onChange={(v: typeof optionsConfig) => {
      setOptionsConfig(prev => ({
        ...prev,
        ...v,
      }));
    }} />;

    /**
     * Intercept each SSE chunk from the agentscope-runtime stream.
     * The library calls responseParser(chunk.data) for every SSE line.
     * When a message with metadata containing sandbox URLs arrives, capture them.
     */
    const responseParser = (chunkData: string) => {
      const parsed = JSON.parse(chunkData);
      if (
        parsed?.object === 'message' &&
        parsed?.metadata?.vnc_url
      ) {
        console.log('[BrowserViewer] vnc_url received:', parsed.metadata.vnc_url);
        setVncUrlRef.current(parsed.metadata.vnc_url);
      }
      return parsed;
    };

    return {
      ...optionsConfig,
      api: {
        ...optionsConfig.api,
        responseParser,
      },
      session: {
        multiple: true,
        api: sessionApi,
      },
      theme: {
        ...optionsConfig.theme,
        rightHeader,
      },
      customToolRenderConfig: {
        'weather search mock': Weather,
      },
    } as unknown as IAgentScopeRuntimeWebUIOptions;
  }, [optionsConfig]);

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>
      {/* Chat panel */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
        <AgentScopeRuntimeWebUI options={options} />
      </div>

      {/* Browser viewer panel — always mounted so it can connect immediately when URL arrives */}
      <div style={{
        width: '45%',
        flexShrink: 0,
        borderLeft: '1px solid #2a2a3e',
        overflow: 'hidden',
      }}>
        <BrowserViewer vncUrl={vncUrl} />
      </div>
    </div>
  );
}