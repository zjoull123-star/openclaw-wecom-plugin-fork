import { OpenClawPluginApi } from 'openclaw/plugin-sdk';

declare const plugin: {
    id: string;
    name: string;
    description: string;
    configSchema: any;
    register(api: OpenClawPluginApi): void;
};

export { plugin as default };
