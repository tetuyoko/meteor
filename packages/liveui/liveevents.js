Meteor.ui = Meteor.ui || {};

// LiveEvents is an implementation of event delegation, a technique that
// listens to events on a subtree of the DOM by binding handlers on the
// root.
//
// _attachEvents installs handlers on a range of nodes, specifically the
// top-level nodes of a template in LiveUI, and detects events on
// descendents using bubbling.  Events that bubble up are checked
// against the selectors in the event map to determine whether the
// user callback should be called.
//
// XXX We currently rely on jQuery for:
// - focusin/focusout support for Firefox
// - keeping track of handlers that have been bound
// - cross-browser event attaching (attachEvent/addEventListener)
// - event field and callback normalization (event.target, etc.)
//
// TODO: Fix event bubbling between multiple handlers.  Have a story for
// the order of handler invocation and stick to it, and have
// event.stopPropagation() always do the right thing.
// For example, in a DOM of the form DIV > UL > LI, we might have
// an event selector on the DIV of the form "click ul, click li" or
// even "click *".  In either case, every matched element should be
// visited in bottom-up order in a single traversal.  To do this,
// we need to have only one event handler per event type per liverange.
// Then, what about events bound at different levels?  Currently,
// handler firing order is determined first by liverange nesting
// level, and then by element nesting level.  For example, if a
// liverange around the DIV selects the LI for an event, and a
// liverange around the UL selects the UL, then you'd think an
// event on the LI would bubble LI -> UL -> DIV.  However, the handler
// on the UL will fire first.  This might be something to document
// rather than fix -- i.e., handlers in event maps in inner liveranges
// will always fire before those in outer liveranges, regardless of
// the selected nodes.  Most solutions requiring taking over the
// entire event flow, making live events play less well with the
// rest of the page or events bound by other libraries.  For example,
// binding all handlers at the top level of the document, or completely
// faking event bubbling somehow.

(function() {

  // Wire up events to DOM nodes.
  //
  // `start` and `end` are sibling nodes in order that define
  // an inclusive range of DOM nodes.  `events` is an event map,
  // and `event_data` the object to bind to the callback (like the
  // Meteor.ui.render options of the same names).
  Meteor.ui._attachEvents = function (start, end, events, event_data) {
    events = events || {};

    // iterate over `spec: callback` map
    _.each(events, function(callback, spec) {
      var clauses = spec.split(/,\s+/);
      _.each(clauses, function (clause) {
        var parts = clause.split(/\s+/);
        if (parts.length === 0)
          return;

        var eventType = parts.shift();
        var selector = parts.join(' ');
        var rewrittenEventType = eventType;
        var bubbles = true;
        // Rewrite focus and blur to non-bubbling focusin and focusout.
        // We are relying on jquery to simulate focusin/focusout in Firefox,
        // the only major browser that lacks support for them.
        // When removing jquery dependency, use event capturing in Firefox,
        // focusin/focusout in IE, and either in WebKit.
        switch (eventType) {
        case 'focus':
          rewrittenEventType = 'focusin';
          bubbles = false;
          break;
        case 'blur':
          rewrittenEventType = 'focusout';
          bubbles = false;
          break;
        case 'change':
          if (wireIEChangeSubmitHack)
            rewrittenEventType = 'cellchange';
          break;
        case 'submit':
          if (wireIEChangeSubmitHack)
            rewrittenEventType = 'datasetcomplete';
          break;
        }

        var attach = function(renderNode) {
          $.event.add(renderNode, rewrittenEventType+".liveui", function(evt) {
            var contextNode = renderNode.parentNode;
            evt.type = eventType;
            if (selector) {
              // use element's parentNode as a "context"; any elements
              // referenced in the selector must be proper descendents
              // of the context.
              var results = $(contextNode).find(selector);
              // target or ancestor must match selector
              var selectorMatch = null;
              for(var curNode = evt.target;
                  curNode !== contextNode;
                  curNode = curNode.parentNode) {
                if (_.contains(results, curNode)) {
                  // found the node that justifies handling
                  // this event
                  selectorMatch = curNode;
                  break;
                }
                if (! bubbles)
                  break;
              }

              if (! selectorMatch)
                return;
            }
            callback.call(event_data, evt);
          });
        };

        var after = end.nextSibling;
        for(var n = start; n && n !== after; n = n.nextSibling)
          attach(n);

      });
    });
  };

  // Prepare newly-created DOM nodes for event delegation.
  //
  // This is a notification to liveevents that gives it a chance
  // to perform custom processing on nodes.  `start` and `end`
  // specify an inclusive range of siblings, and these nodes
  // and their descendents are processed, inserting any hooks
  // needed to make event delegation work.
  Meteor.ui._prepareForEvents = function(start, end) {
    // In old IE, 'change' and 'submit' don't bubble, so we need
    // to register special handlers.
    if (wireIEChangeSubmitHack)
      wireIEChangeSubmitHack(start, end);
  };

  // Removes any events bound by Meteor.ui._attachEvent from
  // `node`.
  Meteor.ui._resetEvents = function(node) {
    // We rely on jquery to keep track of the events
    // we have bound so that we can unbind them.
    $(node).unbind(".liveui");
  };

  // Make 'change' event bubble in IE 6-8, the only browser where it
  // doesn't.  We also fix the quirk that change events on checkboxes
  // and radio buttons don't fire until blur, also on IE 6-8 and no
  // other known browsers.
  //
  // Our solution is to bind an event handler to every element that
  // might be the target of a change event.  The event handler is
  // generic, and simply refires a 'cellchange' event, an obscure
  // IE event that does bubble and is unlikely to be used in an app.
  // To fix checkboxes and radio buttons, use the 'propertychange'
  // event instead of 'change'.
  //
  // We solve the 'submit' event problem similarly, using the IE
  // 'datasetcomplete' event to bubble up a form submission.
  // The tricky part is that the app must be able to call
  // event.preventDefault() and have the form not submit.  This
  // is solved by blocking the original submit and calling
  // submit() later, which never fires a 'submit' event itself.
  //
  // Relevant info:
  // http://www.quirksmode.org/dom/events/change.html
  var wireIEChangeSubmitHack = null;
  if (document.attachEvent &&
      (! ('onchange' in document)) &&
      ('oncellchange' in document) &&
      ('ondatasetcomplete' in document)) {
    // IE <= 8
    wireIEChangeSubmitHack = function(start, end) {
      var wireNode = function(n) {
        if (n.nodeName === 'INPUT') {
          if (n.type === "checkbox" || n.type === "radio") {
            n.detachEvent('onpropertychange', changeSubmitHandlerIE);
            n.attachEvent('onpropertychange', changeSubmitHandlerIE);
          } else {
            n.detachEvent('onchange', changeSubmitHandlerIE);
            n.attachEvent('onchange', changeSubmitHandlerIE);
          }
        } else if (n.nodeName === 'FORM') {
          n.detachEvent('onsubmit', changeSubmitHandlerIE);
          n.attachEvent('onsubmit', changeSubmitHandlerIE);
        }
      };

      var after = end.nextSibling;
      for(var n = start; n && n !== after; n = n.nextSibling) {
        wireNode(n);
        if (n.firstChild) { // element nodes only
          _.each(n.getElementsByTagName('INPUT'), wireNode);
          _.each(n.getElementsByTagName('FORM'), wireNode);
        }
      }
    };
    // implement form submission after app has had a chance
    // to preventDefault
    document.attachEvent('ondatasetcomplete', function() {
      var evt = window.event;
      var target = evt && evt.srcElement;
      if (target && target.nodeName === 'FORM' &&
          evt.returnValue !== false)
        target.submit();
    });
  };

  // this function must be a singleton (i.e. only one instance of it)
  // so that detachEvent can find it.
  var changeSubmitHandlerIE = function() {
    var evt = window.event;
    var target = evt && evt.srcElement;
    if (! target)
      return;

    var newEvent = document.createEventObject();

    if (evt.type === 'propertychange' && evt.propertyName === 'checked'
        || evt.type === 'change') {
      // we appropriate 'oncellchange' as bubbling change
      target.fireEvent('oncellchange', newEvent);
    }

    if (evt.type === 'submit') {
      // we appropriate 'ondatasetcomplete' as bubbling submit.
      // call preventDefault now, let event bubble, and we
      // will submit the form later if the app doesn't
      // prevent it.
      evt.returnValue = false;
      target.fireEvent('ondatasetcomplete', newEvent);
    }
  };

})();