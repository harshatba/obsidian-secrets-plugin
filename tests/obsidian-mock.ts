// Minimal mock of the Obsidian API for testing

export class App {
	vault = new Vault();
	workspace = new Workspace();
	metadataCache = new MetadataCache();
}

export class Vault {
	private files: Map<string, string> = new Map();

	// Test helpers
	_set(path: string, content: string) {
		this.files.set(path, content);
	}
	_get(path: string): string | undefined {
		return this.files.get(path);
	}

	async read(file: TFile): Promise<string> {
		return this.files.get(file.path) ?? "";
	}

	async modify(file: TFile, content: string): Promise<void> {
		this.files.set(file.path, content);
	}

	getMarkdownFiles(): TFile[] {
		return [...this.files.keys()]
			.filter((p) => p.endsWith(".md"))
			.map((p) => new TFile(p));
	}

	on(_event: string, _cb: (...args: any[]) => any) {
		return { id: Math.random() };
	}
}

export class Workspace {
	on(_event: string, _cb: (...args: any[]) => any) {
		return { id: Math.random() };
	}
	getActiveFile() {
		return null;
	}
	getActiveViewOfType(_type: any) {
		return null;
	}
	getMostRecentLeaf() {
		return null;
	}
	onLayoutReady(cb: () => void) {
		cb();
	}
}

export class MetadataCache {
	private cache: Map<string, any> = new Map();

	_setCache(path: string, data: any) {
		this.cache.set(path, data);
	}

	getFileCache(file: TFile) {
		return this.cache.get(file.path) ?? null;
	}

	on(_event: string, _cb: (...args: any[]) => any) {
		return { id: Math.random() };
	}
}

export class TFile {
	path: string;
	basename: string;
	extension: string;
	name: string;
	stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };

	constructor(path: string) {
		this.path = path;
		this.name = path.split("/").pop() ?? path;
		this.extension = this.name.split(".").pop() ?? "";
		this.basename = this.name.replace(/\.[^.]+$/, "");
	}
}

export class TAbstractFile {
	path = "";
}

export class Notice {
	constructor(_message: string, _timeout?: number) {}
}

export class Modal {
	app: App;
	contentEl = createMockEl();
	modalEl = createMockEl();

	constructor(app: App) {
		this.app = app;
	}
	open() {}
	close() {}
	onOpen() {}
	onClose() {}
	setTitle(_title: string) {}
}

export class Plugin {
	app: App;
	manifest = { id: "test", name: "Test", version: "1.0.0" };

	constructor(app: App, manifest: any) {
		this.app = app;
		this.manifest = manifest;
	}
	async loadData() {
		return {};
	}
	async saveData(_data: any) {}
	addCommand(_cmd: any) {}
	addRibbonIcon(_icon: string, _title: string, _cb: () => void) {}
	addSettingTab(_tab: any) {}
	addStatusBarItem() {
		return createMockEl();
	}
	registerEvent(_ref: any) {}
	registerInterval(_id: number) {}
	registerDomEvent(_el: any, _event: string, _cb: any) {}
}

export class PluginSettingTab {
	app: App;
	plugin: any;
	containerEl = createMockEl();

	constructor(app: App, plugin: any) {
		this.app = app;
		this.plugin = plugin;
	}
	display() {}
}

export class Setting {
	constructor(_el: any) {}
	setName(_name: string) {
		return this;
	}
	setDesc(_desc: string) {
		return this;
	}
	addText(_cb: any) {
		return this;
	}
	addDropdown(_cb: any) {
		return this;
	}
	addToggle(_cb: any) {
		return this;
	}
	addButton(_cb: any) {
		return this;
	}
}

export class Component {
	load() {}
	unload() {}
}

export class MarkdownView {
	app: App;
	file: TFile | null = null;
	contentEl = createMockEl();

	constructor(leaf?: any) {
		this.app = leaf?.app ?? new App();
	}
	addAction(_icon: string, _title: string, _cb: () => void) {
		return createMockEl();
	}
	getMode() {
		return "preview";
	}
}

export class MarkdownRenderer {
	static async render(
		_app: App,
		_markdown: string,
		_el: any,
		_sourcePath: string,
		_component: Component
	) {}
}

export class WorkspaceLeaf {
	view: any = null;
}

export class Menu {
	addItem(_cb: any) {
		return this;
	}
}

export const Platform = {
	isMacOS: false,
	isIosApp: false,
	isMobileApp: false,
	isDesktopApp: true,
};

// Helper to create a mock DOM element
function createMockEl(): any {
	const children: any[] = [];
	const el: any = {
		children,
		innerHTML: "",
		textContent: "",
		style: {},
		classList: { add: () => {}, remove: () => {}, contains: () => false },
		addClass: (..._cls: string[]) => {},
		removeClass: (..._cls: string[]) => {},
		empty: () => {
			children.length = 0;
		},
		remove: () => {},
		setText: (t: string) => {
			el.textContent = t;
		},
		createEl: (_tag: string, _opts?: any) => createMockEl(),
		createDiv: (_opts?: any) => createMockEl(),
		appendChild: (child: any) => children.push(child),
		querySelectorAll: (_sel: string) => [],
		addEventListener: (_evt: string, _cb: any) => {},
		isConnected: true,
	};
	return el;
}
