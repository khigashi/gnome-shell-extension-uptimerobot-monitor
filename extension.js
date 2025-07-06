import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import Soup from 'gi://Soup';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';

const UPTIME_ROBOT_API_URL = 'https://api.uptimerobot.com/v2/getMonitors';
const CHECK_INTERVAL = 60;
const RETRY_INTERVAL = 5;
const MAX_RETRIES = 3;

const STATUS = {
    UP: 'up',
    DOWN: 'down',
    ERROR: 'error',
    PAUSED: 'PAUSED',
    UNKNOWN: 'unknown'
};

const MONITOR_STATUS = {
    PAUSED: 0,
    NOT_CHECKED: 1,
    UP: 2,
    SEEMS_DOWN: 8,
    DOWN: 9
};

export default class UptimeRobotExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._timeoutId = null;
        this._httpSession = null;
        this._previousStatus = null;
        this._pulseAnimationId = null;
        this._lastUpdateTime = null;
        this._retryCount = 0;
        this._retryTimeoutId = null;
        this._isCheckingStatus = false;
        this._settings = null;
        this._settingsChangedId = null;
        this._apiKeyValid = false;
    }

    enable() {
        this._createIndicator();
        this._initHttpSession();
        this._initSettings();
        this._checkStatus();
    }

    disable() {
        console.log('UptimeRobot Monitor: Disabling extension');
        
        this._clearAllTimeouts();
        this._disconnectSettings();
        
        if (this._httpSession) {
            this._httpSession.abort();
            this._httpSession = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._previousStatus = null;
        this._lastUpdateTime = null;
        this._retryCount = 0;
        this._isCheckingStatus = false;
        this._apiKeyValid = false;
        
        console.log('UptimeRobot Monitor: Extension disabled successfully');
    }
    
    _clearAllTimeouts() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }
        
        if (this._retryTimeoutId) {
            GLib.Source.remove(this._retryTimeoutId);
            this._retryTimeoutId = null;
        }

        if (this._pulseAnimationId) {
            GLib.Source.remove(this._pulseAnimationId);
            this._pulseAnimationId = null;
        }
    }

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.0, "UptimeRobot Monitor", false);
        
        this._icon = new St.Icon({
            icon_name: 'face-uncertain-symbolic',
            style_class: 'system-status-icon'
        });
        this._indicator.add_child(this._icon);

        this._dashboardItem = new PopupMenu.PopupMenuItem('Open UptimeRobot Dashboard');
        this._dashboardItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://uptimerobot.com/dashboard', null);
        });
        this._indicator.menu.addMenuItem(this._dashboardItem);
        
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        this._monitorSection = new PopupMenu.PopupMenuSection();
        this._indicator.menu.addMenuItem(this._monitorSection);
        
        this._loadingItem = new PopupMenu.PopupMenuItem('Loading monitors...');
        this._loadingItem.setSensitive(false);
        this._monitorSection.addMenuItem(this._loadingItem);
        Main.panel.addToStatusArea('uptime-robot-monitor', this._indicator);
    }

    _initHttpSession() {
        this._httpSession = new Soup.Session();
    }

    _initSettings() {
        this._settings = this.getSettings();
        this._settingsChangedId = this._settings.connect('changed::api-key', () => {
            console.log('UptimeRobot Monitor: API key changed, updating status');
            this._validateApiKey();
            this._checkStatus();
        });
        this._validateApiKey();
    }

    _disconnectSettings() {
        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._settings = null;
    }

    _validateApiKey() {
        if (!this._settings) {
            this._apiKeyValid = false;
            return;
        }
        
        const apiKey = this._settings.get_string('api-key');
        
        this._apiKeyValid = apiKey && 
                           apiKey.trim() !== '' && 
                           apiKey.length > 10 && 
                           /^[a-zA-Z0-9_-]+$/.test(apiKey);
        
        console.log(`UptimeRobot Monitor: API key validation result: ${this._apiKeyValid}`);
    }

    _checkStatus() {
        if (this._isCheckingStatus) {
            console.log('UptimeRobot Monitor: Status check already in progress, skipping');
            return;
        }
        
        this._isCheckingStatus = true;
        
        this._validateApiKey();
        
        if (!this._apiKeyValid) {
            console.log('UptimeRobot Monitor: Invalid or missing API key, setting error status');
            this._setIconStatus(STATUS.ERROR);
            this._updateMenuForInvalidApiKey();
            this._isCheckingStatus = false;
            this._scheduleNextCheck();
            return;
        }
        
        const apiKey = this._settings.get_string('api-key');
        console.log('UptimeRobot Monitor: Checking status with valid API key');
        

        this._makeRequest(apiKey, (response) => {
            this._clearRetryTimeout();
            
            if (response && response.rateLimit) {
                this._handleRateLimit(response.waitSeconds);
                return;
            }
            
            if (response) {
                console.log(`UptimeRobot Monitor: API response received: ${JSON.stringify(response)}`);
            } else {
                console.log('UptimeRobot Monitor: API request failed - no response received');
            }
            
            if (!response || response.stat !== 'ok' || !response.monitors || !Array.isArray(response.monitors)) {
                this._handleApiError(response);
                return;
            }
            
            this._processMonitors(response.monitors);
        });
    }

    _makeRequest(apiKey, callback) {
        const message = Soup.Message.new('POST', UPTIME_ROBOT_API_URL);
        
        message.request_headers.append('Content-Type', 'application/x-www-form-urlencoded');
        message.request_headers.append('User-Agent', 'GNOME Shell Extension UptimeRobot Monitor');

        const formData = `api_key=${encodeURIComponent(apiKey)}`;
        message.set_request_body_from_bytes('application/x-www-form-urlencoded', 
            new GLib.Bytes(formData));
        this._httpSession.timeout = 30;
        this._httpSession.idle_timeout = 30;

        this._httpSession.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (session, result) => {
                try {
                    const bytes = session.send_and_read_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const data = decoder.decode(bytes.get_data());
                    
                    if (!data || data.trim() === '') {
                        console.log('UptimeRobot Monitor: Empty response received from API');
                        callback(null);
                        return;
                    }
                    let response;
                    try {
                        if (data.includes('Rate limit exceeded, retry in')) {
                            const waitTimeMatch = data.match(/retry in (\d+) seconds/);
                            if (waitTimeMatch && waitTimeMatch[1]) {
                                const waitTimeSeconds = parseInt(waitTimeMatch[1]);
                                console.log(`UptimeRobot Monitor: Rate limit exceeded. Will wait ${waitTimeSeconds} seconds as suggested by API`);
                                callback({
                                    rateLimit: true,
                                    waitSeconds: waitTimeSeconds
                                });
                                return;
                            }
                        }
                        
                        response = JSON.parse(data);
                    } catch (parseError) {
                        console.log(`UptimeRobot Monitor: Error: Invalid JSON response from API. Data received: ${data.substring(0, 100)}${data.length > 100 ? '...' : ''}`);
                        console.log(`UptimeRobot Monitor: JSON Parse Error: ${parseError}`);
                        callback(null);
                        return;
                    }
                    
                    if (message.status_code !== 200) {
                        console.log(`UptimeRobot Monitor: HTTP Error ${message.status_code}: ${message.reason_phrase}`);
                        callback(null);
                        return;
                    }
                    if (response.stat !== 'ok') {
                        console.log(`UptimeRobot Monitor: API Error: ${response.error ? response.error.message : 'Unknown error'}`);
                        callback(null);
                        return;
                    }
                    
                    callback(response);
                } catch (e) {
                    console.log(`UptimeRobot Monitor: Error: ${e}`);
                    callback(null);
                }
            }
        );
    }

    _mapStatusCode(statusCode) {
        switch(statusCode) {
            case MONITOR_STATUS.PAUSED: return STATUS.PAUSED;
            case MONITOR_STATUS.NOT_CHECKED: return 'NOT_CHECKED';
            case MONITOR_STATUS.UP: return 'UP';
            case MONITOR_STATUS.SEEMS_DOWN: return 'SEEMS_DOWN';
            case MONITOR_STATUS.DOWN: return 'DOWN';
            default: return STATUS.UNKNOWN;
        }
    }

    _updateMenu(monitors) {
        this._monitorSection.removeAll();
        if (!this._apiKeyValid) {
            this._updateMenuForInvalidApiKey();
            return;
        }
        
        if (this._lastUpdateTime) {
            const timeString = this._lastUpdateTime.toLocaleTimeString();
            const dateString = this._lastUpdateTime.toLocaleDateString();
            const lastUpdateItem = new PopupMenu.PopupMenuItem(`Last update: ${timeString} ${dateString}`);
            lastUpdateItem.setSensitive(false);
            this._monitorSection.addMenuItem(lastUpdateItem);
            this._monitorSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        }
        
        if (!monitors || monitors.length === 0) {
            const noMonitorsItem = new PopupMenu.PopupMenuItem('No monitors found');
            noMonitorsItem.setSensitive(false);
            this._monitorSection.addMenuItem(noMonitorsItem);
            return;
        }
        
        const activeMonitors = monitors.filter(m => m.status !== 'PAUSED');
        const upMonitors = activeMonitors.filter(m => m.status === 'UP');
        const downMonitors = activeMonitors.filter(m => m.status === 'DOWN');
        const pausedMonitors = monitors.filter(m => m.status === 'PAUSED');
        
        const summaryText = `${upMonitors.length} UP, ${downMonitors.length} DOWN${pausedMonitors.length > 0 ? `, ${pausedMonitors.length} PAUSED` : ''}`;
        const summaryItem = new PopupMenu.PopupMenuItem(summaryText);
        summaryItem.setSensitive(false);
        this._monitorSection.addMenuItem(summaryItem);
        
        if (activeMonitors.length > 0) {
            this._monitorSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            
            if (downMonitors.length > 0) {
                downMonitors.forEach(monitor => {
                    const item = new PopupMenu.PopupMenuItem(`🔴 ${monitor.friendlyName}`);
                    item.connect('activate', () => {
                        Gio.AppInfo.launch_default_for_uri(monitor.url, null);
                    });
                    this._monitorSection.addMenuItem(item);
                });
            }
        }
    }

    _updateMenuForInvalidApiKey() {
        this._monitorSection.removeAll();
        
        const errorTitle = new PopupMenu.PopupMenuItem('⚠️ Configuration Required');
        errorTitle.setSensitive(false);
        errorTitle.label.add_style_class_name('popup-menu-item-title');
        this._monitorSection.addMenuItem(errorTitle);
        
        this._monitorSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        const instructionItem = new PopupMenu.PopupMenuItem('API key not configured or invalid');
        instructionItem.setSensitive(false);
        this._monitorSection.addMenuItem(instructionItem);
        
        const instructionItem2 = new PopupMenu.PopupMenuItem('Configure your API key in preferences');
        instructionItem2.setSensitive(false);
        this._monitorSection.addMenuItem(instructionItem2);
        
        this._monitorSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        
        const prefsItem = new PopupMenu.PopupMenuItem('Open Preferences');
        prefsItem.connect('activate', () => {
            this.openPreferences();
        });
        this._monitorSection.addMenuItem(prefsItem);
        
        const helpItem = new PopupMenu.PopupMenuItem('How to get API key');
        helpItem.connect('activate', () => {
            Gio.AppInfo.launch_default_for_uri('https://uptimerobot.com/dashboard#mySettings', null);
        });
        this._monitorSection.addMenuItem(helpItem);
    }

    _setIconStatus(status) {
        let iconName = 'face-uncertain-symbolic';
        
        this._stopIconToggleAnimation();
        
        switch(status) {
            case STATUS.UP:
                const iconPath = this.path + '/icons/status-up.svg';
                if (this._iconFileExists(iconPath)) {
                    const iconFile = Gio.File.new_for_path(iconPath);
                    this._icon.gicon = new Gio.FileIcon({ file: iconFile });
                    this._icon.icon_name = null;
                } else {
                    this._icon.gicon = null;
                    this._icon.icon_name = 'face-smile-symbolic';
                }
                this._icon.style = '';
                break;
            case STATUS.DOWN:
                const downIconPath = this.path + '/icons/status-down.svg';
                if (this._iconFileExists(downIconPath)) {
                    const downIconFile = Gio.File.new_for_path(downIconPath);
                    this._icon.gicon = new Gio.FileIcon({ file: downIconFile });
                    this._icon.icon_name = null;
                } else {
                    this._icon.gicon = null;
                    this._icon.icon_name = 'face-sad-symbolic';
                }
                this._startIconToggleAnimation();
                break;
            case STATUS.ERROR:
                iconName = 'dialog-error-symbolic';
                this._icon.gicon = null;
                this._icon.icon_name = iconName;
                this._icon.style = 'color: #FF9800;';
                break;
            default:
                this._icon.gicon = null;
                this._icon.icon_name = iconName;
                this._icon.style = '';
                break;
        }
    }

    _startIconToggleAnimation() {
        let useNormalIcon = true;
        const normalIconPath = this.path + '/icons/status-down.svg';
        const fadeIconPath = this.path + '/icons/status-down-fade.svg';
        if (!this._iconFileExists(normalIconPath) || !this._iconFileExists(fadeIconPath)) {
            console.log('UptimeRobot Monitor: Icon files not found, skipping animation');
            return;
        }
        
        if (this._pulseAnimationId) {
            GLib.Source.remove(this._pulseAnimationId);
        }
        
        this._pulseAnimationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            const iconPath = useNormalIcon ? fadeIconPath : normalIconPath;
            if (this._iconFileExists(iconPath)) {
                const iconFile = Gio.File.new_for_path(iconPath);
                this._icon.gicon = new Gio.FileIcon({ file: iconFile });
            }
            
            useNormalIcon = !useNormalIcon;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopIconToggleAnimation() {
        if (this._pulseAnimationId) {
            GLib.Source.remove(this._pulseAnimationId);
            this._pulseAnimationId = null;
            const normalIconPath = this.path + '/icons/status-down.svg';
            if (this._iconFileExists(normalIconPath)) {
                const normalIconFile = Gio.File.new_for_path(normalIconPath);
                this._icon.gicon = new Gio.FileIcon({ file: normalIconFile });
            } else {
                this._icon.gicon = null;
                this._icon.icon_name = 'face-sad-symbolic';
            }
        }
    }

    _iconFileExists(iconPath) {
        const file = Gio.File.new_for_path(iconPath);
        return file.query_exists(null);
    }

    _clearRetryTimeout() {
        if (this._retryTimeoutId) {
            GLib.Source.remove(this._retryTimeoutId);
            this._retryTimeoutId = null;
        }
    }

    _handleRateLimit(waitSeconds) {
        console.log(`UptimeRobot Monitor: Rate limit detected. Waiting for ${waitSeconds} seconds before retrying`);
        this._setIconStatus(STATUS.ERROR);
        this._isCheckingStatus = false;
        
        this._clearRetryTimeout();
        
        this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, waitSeconds, () => {
            console.log('UptimeRobot Monitor: Retrying after rate limit wait period');
            this._checkStatus();
            return GLib.SOURCE_REMOVE;
        });
    }

    _handleApiError(response) {
        const errorMsg = response && response.error ? response.error.message : 'Unknown error';
        console.log(`UptimeRobot Monitor: API Error: ${errorMsg}`);
        this._setIconStatus(STATUS.ERROR);
        
        this._retryCount = 0;
        this._isCheckingStatus = false;
        
        this._scheduleNextCheck();
    }

    _processMonitors(monitors) {
        const processedMonitors = monitors.map(monitor => ({
            ...monitor,
            status: this._mapStatusCode(monitor.status),
            friendlyName: monitor.friendly_name
        }));
        
        const activeMonitors = processedMonitors.filter(monitor => monitor.status !== STATUS.PAUSED);
        let newStatus = STATUS.UP;
        if (activeMonitors.some(monitor => monitor.status === 'DOWN')) {
            newStatus = STATUS.DOWN;
        }
        
        this._setIconStatus(newStatus);
        this._lastUpdateTime = new Date();
        this._updateMenu(processedMonitors);
        this._handleStatusChange(newStatus, activeMonitors);
        this._previousStatus = newStatus;
        this._isCheckingStatus = false;
        this._scheduleNextCheck();
    }

    _handleStatusChange(newStatus, activeMonitors) {
        const isFirstLoad = this._previousStatus === null;
        const hasStatusChanged = this._previousStatus !== null && this._previousStatus !== newStatus;
        
        console.log(`UptimeRobot Monitor: isFirstLoad=${isFirstLoad}, hasStatusChanged=${hasStatusChanged}, newStatus=${newStatus}, previousStatus=${this._previousStatus}`);
        
        if (hasStatusChanged || (isFirstLoad && newStatus === STATUS.DOWN)) {
            if (newStatus === STATUS.DOWN) {
                const downSites = activeMonitors.filter(monitor => monitor.status === 'DOWN');
                const title = isFirstLoad ? 'Sites down detected!' : 'Sites are down!';
                const message = isFirstLoad ? 
                    `Found ${downSites.length} site(s) currently offline: ${downSites.map(m => m.friendlyName).join(', ')}` :
                    `${downSites.length} site(s) are currently offline: ${downSites.map(m => m.friendlyName).join(', ')}`;
                
                console.log(`UptimeRobot Monitor: Showing notification - ${title}: ${message}`);
                this._showNotification(title, message);
                
                this._configureRetry();
            } else if (hasStatusChanged) {
                console.log('UptimeRobot Monitor: Showing notification - All sites online');
                this._showNotification(
                    'All sites are online!', 
                    'All your monitored sites are now online.'
                );
            }
        }
    }

    _configureRetry() {
        if (this._retryCount < MAX_RETRIES) {
            this._retryCount++;
            this._clearRetryTimeout();
            
            this._retryTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, RETRY_INTERVAL, () => {
                console.log(`UptimeRobot Monitor: Retrying API request (attempt ${this._retryCount} of ${MAX_RETRIES})`);
                this._checkStatus();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            console.log(`UptimeRobot Monitor: Reached maximum retries (${MAX_RETRIES}). Resuming normal check interval.`);
            this._retryCount = 0;
        }
    }

    _scheduleNextCheck() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
        }
        
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CHECK_INTERVAL, () => {
            this._checkStatus();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _showNotification(title, message) {
        const source = new MessageTray.Source({
            title: 'UptimeRobot Monitor',
            iconName: 'dialog-information-symbolic'
        });
        Main.messageTray.add(source);
        
        const notification = new MessageTray.Notification({
            source: source,
            title: title,
            body: message,
            isTransient: false
        });
        source.addNotification(notification);
    }
}

