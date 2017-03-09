"use strict";

var browser = browser || chrome;//for Chrome

const CONTEXT_MENU_ITEM_ROOT_ID = "root";
const CONTEXT_MENU_ITEM_EMPTY_ID = "empty";
const CONTEXT_MENU_ITEM_UNTITLED = browser.i18n.getMessage("contextMenuItemUntitled");
const FOLDERS_GROUP_TITLES_SEP = " ▸ ";
const BOOKMARK_TREE_CHANGES_EVENTS = ["onCreated", "onRemoved", "onChanged", "onMoved", "onChildrenReordered"];
const BOOKMARK_TREE_CHANGES_DELAY = 1000;//ms
const PREF_FLAT_CONTEXT_MENU = "flatContextMenu";

//browser.runtime.lastError

class Bookmarklet{
	constructor(source = "", title = ""){
		this.source = source;
		this.title = title;
	}
}

class BookmarkletFolder{
	constructor(children = [], title = ""){
		this.children = children;
		this.title = title;
	}
}

class BookmarkletFolderGroup extends BookmarkletFolder{
	constructor(folders = [], children = [], title = ""){
		super(children, title);
		this.folders = folders;
	}
}

/**
 * Create bookmarklet tree from given bookmark
 * @returns {Bookmarklet|BookmarkletFolder|BookmarkletFolderGroup|null}
 */
function getBookmarkletTree(bookmark){
	let title = bookmark.title || CONTEXT_MENU_ITEM_UNTITLED;
	
	// If not a folder
	if(!bookmark.children){
		let url = bookmark.url;
		if(url && url.startsWith("javascript:")){
			let source;
			try{
				source = decodeURIComponent(url.slice(11)).trim()
			}catch(error){}
			
			if(source){
				return new Bookmarklet(source, title);
			}
		}
		
		return null;
	}
	
	let children = bookmark.children.map(getBookmarkletTree).filter(value => value !== null);
	if(children.length == 0){
		return null;
	}
	
	let folder = new BookmarkletFolder(children, title);
	
	// Nested folders
	if(children.length == 1 && children[0] instanceof BookmarkletFolder){
		let solitaryFolder = children[0];
		
		// Already a group
		if(solitaryFolder instanceof BookmarkletFolderGroup){
			folder.children[0] = solitaryFolder.folders[0];// fix the tree
			solitaryFolder.folders.unshift(folder);// group that folder too
			solitaryFolder.title = solitaryFolder.folders.map(folder => folder.title).join(FOLDERS_GROUP_TITLES_SEP);
			return solitaryFolder;
		}
		
		return new BookmarkletFolderGroup([folder, solitaryFolder], solitaryFolder.children, folder.title + FOLDERS_GROUP_TITLES_SEP + solitaryFolder.title);
	}
	
	return folder;
}

/**
 * Handle context menu click event
 * Execute corresponding bookmarklet script
 */
function contextMenuItemClick(bookmarklet, data, tab){
	/*
	executeScript can be rejected for host mismatch: "Error: No window matching {"matchesHost":[]}"
	or privilegied URIs like: chrome://* *://addons.mozilla.org/
	See https://bugzilla.mozilla.org/show_bug.cgi?id=1310082
	
	executeScript can be rejected for script error (syntax or privilege)
	*/
	browser.tabs.executeScript({
		code: bookmarklet.source,
		runAt: "document_start"
	}).then(framesReturnValues => {
		let topFrameRetunValue = framesReturnValues[0];
		// top frame retunValue is undefined (void)
		if(topFrameRetunValue === undefined){
			// Do nothing
			return;
		}
			
		// Redirect to document generated by the result of evaluated script
		// We can't use browser.tabs.update({url}) because data: URI aren't allowed
		return browser.tabs.executeScript({
			code: `location = "data:text/html;charset=utf-8,${encodeURIComponent(topFrameRetunValue)}";`,
			runAt: "document_start"
		});
	});
}

/**
 * Create all context menu for the given bookmarklet tree
 */
function createAllContextMenuItems(bookmarklets, flat = false){
	// Remove all remains context menu
	browser.contextMenus.removeAll();
	
	let bookmarkletsRoot = bookmarklets[0];
	// add root context menu
	let parentID = browser.contextMenus.create({
		id: CONTEXT_MENU_ITEM_ROOT_ID,
		title: browser.i18n.getMessage("contextMenuItemRoot"),
		contexts: ["all"]
	});

	// If no bookmarklets
	if(!bookmarkletsRoot || bookmarkletsRoot instanceof BookmarkletFolder && bookmarkletsRoot.children.length == 0){
		browser.contextMenus.create({
			id: CONTEXT_MENU_ITEM_EMPTY_ID,
			title: browser.i18n.getMessage("contextMenuItemEmpty"),
			parentId: parentID,
			contexts: ["all"]
		});
		return;
	}

	// If only one folder (or folder group) list direcly its children
	if(bookmarkletsRoot instanceof BookmarkletFolder){
		bookmarkletsRoot.children.map(child => createContextMenuItems(child, parentID, flat));
	} else {
		createContextMenuItems(bookmarkletsRoot, parentID, flat);
	}
}

/**
 * Create a context menu entry for the given bookmarklet
 */
function createContextMenuItems(bookmarklet, parentContextMenuID, flat = false){
	if(bookmarklet instanceof BookmarkletFolder){
		let parentID = parentContextMenuID;
		if(!flat){
			parentID = browser.contextMenus.create({
				title: bookmarklet.title,
				parentId: parentContextMenuID,
				contexts: ["all"]
			});
		}
		bookmarklet.children.map(child => createContextMenuItems(child, parentID, flat));
		return;
	}
	
	let contextMenuId = browser.contextMenus.create({
		title: bookmarklet.title,
		parentId: parentContextMenuID,
		onclick: contextMenuItemClick.bind(null, bookmarklet),
		contexts: ["all"]
	});
}

/**
 * Build or rebuild the context menu
 * @returns Promise
 */
function updateContextMenu(){
	return browser.storage.local.get(PREF_FLAT_CONTEXT_MENU).then(result => {
		let flat = Boolean(result[PREF_FLAT_CONTEXT_MENU]);
		return gettingBookmarkletTree.then(bookmarklets => createAllContextMenuItems(bookmarklets, flat));
	})
}

/**
 * Update all data: the bookmarklet tree and context menu items
 * @returns Promise
 */
function update(){
	gettingBookmarkletTree = browser.bookmarks.getTree().then(bookmarks => [getBookmarkletTree(bookmarks[0])]);
	return updateContextMenu();
}

/**
 * Bookmark tree events handler throttle / debounce function
 */
function updateDebounced(){
	if(updateTimeoutID){
		// Wait to update timeout
		return;
	}
	
	updateTimeoutID = setTimeout(() => {
		updateTimeoutID = 0;
		update.apply(this);
	}, BOOKMARK_TREE_CHANGES_DELAY);
}

let updateTimeoutID = 0;
let gettingBookmarkletTree = null//Promise.reject("Not initialized");

// Inert context menu (disabled). Wait bookmarks retrival
browser.contextMenus.create({
	id: CONTEXT_MENU_ITEM_ROOT_ID,
	title: browser.i18n.getMessage("contextMenuItemRoot"),
	contexts: ["all"],
	enabled: false
});

// Add bookmark tree changes event listeners
// Don't handle onImportBegan and onImportEnded, but because we debounce (delay) update, it should be fine
{
	const bookmarks = browser.bookmarks;
	for(let event of BOOKMARK_TREE_CHANGES_EVENTS){
		// Event not supported
		if(!(event in bookmarks) || typeof bookmarks[event].addListener != "function"){
			continue;
		}
		
		bookmarks[event].addListener(updateDebounced);
	}
}

update();

// Listen preferences changes
browser.storage.onChanged.addListener((changes, areaName) => {
	// Ignore all others storage areas
	if(areaName != "local"){
		return;
	}
	
	let flatPrefChange = changes[PREF_FLAT_CONTEXT_MENU];
	if(flatPrefChange && flatPrefChange.oldValue != flatPrefChange.newValue){
		updateContextMenu();
	}
})