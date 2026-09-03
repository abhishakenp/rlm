import Foundation
import EventKit

/// Native Swift EventKit integration for Reminders and Calendar access
/// Provides unified access to macOS/iOS Reminders and Calendar through EventKit
public final class EKEventStore {
    
    // MARK: - Properties
    
    private let eventStore: EKEventStore
    private let queue = DispatchQueue(label: "com.rlm.eventkit", qos: .userInitiated)
    
    public enum EventKitError: Error, LocalizedError {
        case accessDenied
        case calendarNotFound
        case reminderNotFound
        case eventNotFound
        case saveFailed(Error)
        case deleteFailed(Error)
        
        public var errorDescription: String? {
            switch self {
            case .accessDenied: return "EventKit access was denied"
            case .calendarNotFound: return "Calendar not found"
            case .reminderNotFound: return "Reminder list not found"
            case .eventNotFound: return "Event not found"
            case .saveFailed(let error): return "Save failed: \(error.localizedDescription)"
            case .deleteFailed(let error): return "Delete failed: \(error.localizedDescription)"
            }
        }
    }
    
    // MARK: - Initialization
    
    public init() {
        self.eventStore = EKEventStore()
    }
    
    /// Request access to EventKit (Reminders and/or Calendars)
    /// - Parameters:
    ///   - reminders: Whether to request reminders access
    ///   - calendars: Whether to request calendars access
    ///   - completion: Callback with success status for each type
    public func requestAccess(
        reminders: Bool = true,
        calendars: Bool = true,
        completion: @escaping (Bool, Bool) -> Void
    ) {
        if #available(macOS 14.0, *) {
            // macOS 14+ uses the new async API
            Task {
                let remindersAccess = reminders ? await requestRemindersAccess() : false
                let calendarsAccess = calendars ? await requestCalendarsAccess() : false
                DispatchQueue.main.async {
                    completion(remindersAccess, calendarsAccess)
                }
            }
        } else {
            // Legacy API for older macOS
            eventStore.requestAccess(to: .reminder) { granted, _ in
                let remindersGranted = granted
                self.eventStore.requestAccess(to: .event) { calendarGranted, _ in
                    DispatchQueue.main.async {
                        completion(remindersGranted, calendarGranted)
                    }
                }
            }
        }
    }
    
    @available(macOS 14.0, *)
    private func requestRemindersAccess() async -> Bool {
        do {
            return try await eventStore.requestFullAccessToReminders()
        } catch {
            return false
        }
    }
    
    @available(macOS 14.0, *)
    private func requestCalendarsAccess() async -> Bool {
        do {
            return try await eventStore.requestFullAccessToEvents()
        } catch {
            return false
        }
    }
    
    // MARK: - Calendar Access
    
    /// Get all calendars
    public func getCalendars() -> [EKCalendar] {
        return eventStore.calendars(for: .event)
    }
    
    /// Find a calendar by title
    public func findCalendar(title: String) -> EKCalendar? {
        return getCalendars().first { $0.title == title }
    }
    
    /// Create a new calendar
    public func createCalendar(
        title: String,
        color: String? = nil,
        completion: @escaping (Result<EKCalendar, EventKitError>) -> Void
    ) {
        let calendar = EKCalendar(for: .event, eventStore: eventStore)
        calendar.title = title
        
        if let colorHex = color {
            calendar.color = NSColor(hex: colorHex) ?? .systemBlue
        }
        
        // Find a suitable source
        if let localSource = eventStore.sources.first(where: { $0.sourceType == .local }) {
            calendar.source = localSource
        } else if let defaultSource = eventStore.defaultCalendarForNewEvents {
            calendar.source = defaultSource
        } else if let firstSource = eventStore.sources.first {
            calendar.source = firstSource
        } else {
            completion(.failure(.accessDenied))
            return
        }
        
        do {
            try eventStore.saveCalendar(calendar, commit: true)
            completion(.success(calendar))
        } catch {
            completion(.failure(.saveFailed(error)))
        }
    }
    
    // MARK: - Event Access
    
    /// Get events within a date range
    public func getEvents(
        from startDate: Date,
        to endDate: Date,
        calendars: [EKCalendar]? = nil
    ) -> [EKEvent] {
        let predicate = eventStore.predicateForEvents(
            withStart: startDate,
            end: endDate,
            calendars: calendars ?? getCalendars()
        )
        return eventStore.events(matching: predicate)
    }
    
    /// Create a new event
    public func createEvent(
        title: String,
        startDate: Date,
        endDate: Date,
        calendar: EKCalendar? = nil,
        notes: String? = nil,
        url: URL? = nil,
        completion: @escaping (Result<EKEvent, EventKitError>) -> Void
    ) {
        let event = EKEvent(eventStore: eventStore)
        event.title = title
        event.startDate = startDate
        event.endDate = endDate
        event.calendar = calendar ?? eventStore.defaultCalendarForNewEvents
        event.notes = notes
        event.url = url
        
        do {
            try eventStore.save(event, span: .thisEvent)
            completion(.success(event))
        } catch {
            completion(.failure(.saveFailed(error)))
        }
    }
    
    /// Update an existing event
    public func updateEvent(
        _ event: EKEvent,
        title: String? = nil,
        startDate: Date? = nil,
        endDate: Date? = nil,
        notes: String? = nil,
        completion: @escaping (Result<EKEvent, EventKitError>) -> Void
    ) {
        if let title = title { event.title = title }
        if let startDate = startDate { event.startDate = startDate }
        if let endDate = endDate { event.endDate = endDate }
        if let notes = notes { event.notes = notes }
        
        do {
            try eventStore.save(event, span: .thisEvent)
            completion(.success(event))
        } catch {
            completion(.failure(.saveFailed(error)))
        }
    }
    
    /// Delete an event
    public func deleteEvent(
        _ event: EKEvent,
        completion: @escaping (Result<Void, EventKitError>) -> Void
    ) {
        do {
            try eventStore.remove(event, span: .thisEvent)
            completion(.success(()))
        } catch {
            completion(.failure(.deleteFailed(error)))
        }
    }
    
    // MARK: - Reminders Access
    
    /// Get all reminder lists
    public func getReminderLists() -> [EKCalendar] {
        return eventStore.calendars(for: .reminder)
    }
    
    /// Find a reminder list by title
    public func findReminderList(title: String) -> EKCalendar? {
        return getReminderLists().first { $0.title == title }
    }
    
    /// Get reminders within a date range
    public func getReminders(
        from startDate: Date? = nil,
        to endDate: Date? = nil,
        lists: [EKCalendar]? = nil
    ) -> [EKReminder] {
        var predicates: [NSPredicate] = []
        
        if let start = startDate, let end = endDate {
            predicates.append(eventStore.predicateForIncompleteReminders(
                withStarting: start,
                ending: end,
                calendars: lists
            ))
        } else if let start = startDate {
            predicates.append(eventStore.predicateForIncompleteReminders(
                withStarting: start,
                ending: nil,
                calendars: lists
            ))
        } else {
            predicates.append(eventStore.predicateForIncompleteReminders(
                withStarting: nil,
                ending: nil,
                calendars: lists
            ))
        }
        
        var reminders: [EKReminder] = []
        for predicate in predicates {
            reminders.append(contentsOf: eventStore.reminders(matching: predicate))
        }
        return reminders
    }
    
    /// Get all reminders (including completed)
    public func getAllReminders(lists: [EKCalendar]? = nil) -> [EKReminder] {
        let predicate = eventStore.predicateForReminders(in: lists)
        return eventStore.reminders(matching: predicate)
    }
    
    /// Create a new reminder
    public func createReminder(
        title: String,
        list: EKCalendar? = nil,
        dueDate: Date? = nil,
        notes: String? = nil,
        priority: Int = 0,
        completion: @escaping (Result<EKReminder, EventKitError>) -> Void
    ) {
        let reminder = EKReminder(eventStore: eventStore)
        reminder.title = title
        reminder.calendar = list ?? getReminderLists().first
        reminder.notes = notes
        reminder.priority = priority
        
        if let due = dueDate {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute],
                from: due
            )
        }
        
        guard let calendar = reminder.calendar else {
            completion(.failure(.reminderNotFound))
            return
        }
        
        do {
            try eventStore.save(reminder, commit: true)
            completion(.success(reminder))
        } catch {
            completion(.failure(.saveFailed(error)))
        }
    }
    
    /// Mark a reminder as completed
    public func completeReminder(
        _ reminder: EKReminder,
        completion: @escaping (Result<EKReminder, EventKitError>) -> Void
    ) {
        reminder.completionDate = Date()
        
        do {
            try eventStore.save(reminder, commit: true)
            completion(.success(reminder))
        } catch {
            completion(.failure(.saveFailed(error)))
        }
    }
    
    /// Update a reminder
    public func updateReminder(
        _ reminder: EKReminder,
        title: String? = nil,
        dueDate: Date? = nil,
        notes: String? = nil,
        priority: Int? = nil,
        completion: @escaping (Result<EKReminder, EventKitError>) -> Void
    ) {
        if let title = title { reminder.title = title }
        if let notes = notes { reminder.notes = notes }
        if let priority = priority { reminder.priority = priority }
        
        if let due = dueDate {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute],
                from: due
            )
        }
        
        do {
            try eventStore.save(reminder, commit: true)
            completion(.success(reminder))
        } catch {
            completion(.failure(.saveFailed(error)))
        }
    }
    
    /// Delete a reminder
    public func deleteReminder(
        _ reminder: EKReminder,
        completion: @escaping (Result<Void, EventKitError>) -> Void
    ) {
        do {
            try eventStore.remove(reminder, commit: true)
            completion(.success(()))
        } catch {
            completion(.failure(.deleteFailed(error)))
        }
    }
    
    // MARK: - Utility
    
    /// Refresh EventKit data from disk
    public func refresh() {
        eventStore.refresh()
    }
    
    /// Check current authorization status for calendars
    public func calendarsAuthorizationStatus() -> EKAuthorizationStatus {
        return EKEventStore.authorizationStatus(for: .event)
    }
    
    /// Check current authorization status for reminders
    public func remindersAuthorizationStatus() -> EKAuthorizationStatus {
        return EKEventStore.authorizationStatus(for: .reminder)
    }
}

// MARK: - NSColor Extension

extension NSColor {
    convenience init?(hex: String) {
        globalThis.hexSanitized = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        hexSanitized = hexSanitized.replacingOccurrences(of: "#", with: "")
        
        var rgb: UInt64 = 0
        guard Scanner(string: hexSanitized).scanHexInt64(&rgb) else { return nil }
        
        let r = CGFloat((rgb & 0xFF0000) >> 16) / 255.0
        let g = CGFloat((rgb & 0x00FF00) >> 8) / 255.0
        let b = CGFloat(rgb & 0x0000FF) / 255.0
        
        self.init(red: r, green: g, blue: b, alpha: 1.0)
    }
}

// MARK: - Observable Support (for SwiftUI)

#if canImport(SwiftUI)
import SwiftUI

@available(macOS 12.0, *)
public final class EventKitObservable: ObservableObject {
    @Published public var calendars: [EKCalendar] = []
    @Published public var reminders: [EKReminder] = []
    @Published public var upcomingEvents: [EKEvent] = []
    @Published public var isAuthorized: Bool = false
    
    private let eventStore: EKEventStore
    
    public init() {
        self.eventStore = EKEventStore()
        refreshData()
    }
    
    public func refreshData() {
        calendars = eventStore.calendars(for: .event)
        
        let now = Date()
        let weekFromNow = Calendar.current.date(byAdding: .day, value: 7, to: now)!
        upcomingEvents = getEvents(from: now, to: weekFromNow)
        
        reminders = getReminders()
    }
    
    public func requestAuthorization(completion: @escaping (Bool) -> Void) {
        eventStore.requestAccess(to: .event) { [weak self] granted, _ in
            DispatchQueue.main.async {
                self?.isAuthorized = granted
                if granted {
                    self?.refreshData()
                }
                completion(granted)
            }
        }
    }
}
#endif
