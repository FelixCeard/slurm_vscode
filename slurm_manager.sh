#!/bin/bash

# Alternative terminal control using tput
BOLD="$(tput bold)"
RESET="$(tput sgr0)"
REVERSE="$(tput smso)"  # Start "standout" mode
REVERSE_RESET="$(tput rmso)"  # End "standout" mode

# Global variables
selected_index=0
jobs_data=()
selected_jobs=()  # Array to store selected job IDs
filter_mode=0  # 0: normal mode, 1: filter mode
filter_text=""
filtered_jobs=()
cursor_pos=0  # Track cursor position in filter text
entered_regex_with_down=0  # Track if regex mode was entered with down arrow

# Function to clear screen and move cursor to top
clear_screen() {
    printf "\033c"
}

# Function to get terminal size
get_terminal_size() {
    read -r LINES COLUMNS < <(stty size)
}

# Function to move cursor to specific position
position_cursor() {
    printf "\033[%d;%dH" "$1" "$2"
}

# Function to get current jobs
get_jobs() {
    local new_jobs=()
    while IFS='|' read -r jobid partition name user status time timelimit nodes nodelist; do
        # Skip header line and only store needed fields
        if [ "$jobid" != "JOBID" ]; then
            new_jobs+=("$jobid|$partition|$name|$status|$time|$timelimit|$nodes|$nodelist")
        fi
    done < <(squeue --me --format="%i|%P|%j|%u|%T|%M|%l|%D|%R" 2>/dev/null)
    
    # Only redraw if jobs changed
    if [ "${#new_jobs[@]}" -ne "${#jobs_data[@]}" ] || [ "${new_jobs[*]}" != "${jobs_data[*]}" ]; then
        jobs_data=("${new_jobs[@]}")
        return 0  # Jobs changed
    fi
    return 1  # No change
}

# Function to check if all jobs are selected
are_all_jobs_selected() {
    # Use parameter expansion for faster array operations
    local selected="${selected_jobs[*]}"
    local count=0
    for job in "${jobs_data[@]}"; do
        jobid="${job%%|*}"  # Faster than using IFS and read
        [[ "$selected" == *" $jobid "* ]] && ((count++))
    done
    [ $count -eq ${#jobs_data[@]} ]
}

# Function to get max name length
get_max_name_length() {
    local max_len=20  # minimum width
    for job in "${jobs_data[@]}"; do
        IFS='|' read -r _ _ name _ _ _ _ <<< "$job"
        if [ ${#name} -gt $max_len ]; then
            max_len=${#name}  # add a small padding
        fi
    done
    echo $((max_len + 2))  # add a small padding
}

# Function to apply filter
apply_filter() {
    filtered_jobs=()
    local pattern="$filter_text"
    
    if [ -z "$pattern" ]; then
        filtered_jobs=("${jobs_data[@]}")
        return
    fi
    
    for job in "${jobs_data[@]}"; do
        if [[ "$job" =~ $pattern ]]; then
            filtered_jobs+=("$job")
        fi
    done
}

# Function to draw the menu
draw_menu() {
    # Cache terminal size
    local lines cols
    read -r lines cols < <(stty size)
    
    # Use printf format strings
    local header_format="%-10s  %-12s  %-${name_width}s  %-10s  %-11s  %-11s  %-7s"
    local job_format="%-10s  %-12s  %-${name_width}s  %-10s  %-11s  %-11s  %-7s"
    
    clear_screen
    
    # Get the width for the name column
    local name_width=$(get_max_name_length)
    
    # Calculate total table width (including selection box and padding)
    local table_width=$((4 + 10 + 13 + name_width + 11 + 12 + 12 + 8))
    
    # Draw header with select all box
    position_cursor 2 2
    printf "%s%*s%s\n" "$BOLD" $(( (table_width + 15) / 2)) "Slurm Job Manager" "$RESET"
    
    # Draw table header
    position_cursor 3 2
    if are_all_jobs_selected; then
        printf "[■] "
    elif [ $selected_index -eq -1 ]; then  # Changed condition
        printf "[x] "
    else
        printf "[ ] "
    fi
    
    # Always highlight the header
    printf "%s%s" "$REVERSE" "$BOLD"
    printf "%-10s  %-12s  %-${name_width}s  %-10s  %-11s  %-11s  %-7s" \
        "ID" "Partition" "Name" "Status" "Time" "Time Limit" "Nodes"
    printf "%s" "$RESET"
    
    # Draw jobs
    local index=0
    for job in "${jobs_data[@]}"; do
        IFS='|' read -r jobid partition name status time timelimit nodes nodelist <<< "$job"
        position_cursor $((5 + index)) 2
        
        # Draw selection box
        if [ $filter_mode -eq 1 ]; then
            # In filter mode, show previously selected jobs as fully selected
            if [[ " ${selected_jobs[@]} " =~ " ${jobid} " ]]; then
                printf "[■] "
            # Show matching but unselected jobs with x - only match against name
            elif [ -n "$filter_text" ] && [[ "$name" =~ $filter_text ]]; then
                printf "[x] "
            else
                printf "[ ] "
            fi
        else
            # Normal mode selection display
            if [[ " ${selected_jobs[@]} " =~ " ${jobid} " ]]; then
                printf "[■] "
            elif [ $index -eq $selected_index ]; then
                printf "[x] "
            else
                printf "[ ] "
            fi
        fi
        
        # Only highlight current selection when not in filter mode
        if [ $filter_mode -eq 0 ] && [ $index -eq $selected_index ]; then
            printf "%s" "$REVERSE"
        fi
        printf "%-10s  %-12s  %-${name_width}s  %-10s  %-11s  %-11s  %-7s" \
            "$jobid" "$partition" "$name" "$status" "$time" "$timelimit" "$nodes"
        if [ $filter_mode -eq 0 ] && [ $index -eq $selected_index ]; then
            printf "%s" "$RESET"
        fi
        
        ((index++))
    done
    
    # Draw filter field
    local filter_line=$((6 + ${#jobs_data[@]}))
    position_cursor $filter_line 2
    if [ $filter_mode -eq 1 ]; then
        printf "%sFilter (regex):%s " "$BOLD" "$RESET"
        # Draw text with cursor
        local text_length=${#filter_text}
        local cursor_char=" "
        if [ $cursor_pos -lt $text_length ]; then
            cursor_char="${filter_text:$cursor_pos:1}"
        fi
        printf "%s" "${filter_text:0:$cursor_pos}"
        printf "\033[7m%s\033[27m" "$cursor_char"
        printf "%s" "${filter_text:$((cursor_pos+1))}"
    else
        printf "%sFilter (regex):%s %s" "$BOLD" "$RESET" "$filter_text"
    fi
    
    # Draw footer with commands right after the filter field
    position_cursor $((filter_line + 2)) 2  # Two lines after filter field
    printf "%sAvailable commands:%s" "$BOLD" "$RESET"
    position_cursor $((filter_line + 3)) 2
    if [ ${#selected_jobs[@]} -gt 0 ]; then
        printf "1: Cancel job(s) | %s2: SSH node | 3: Attach job | 4: Details%s | 9: Exit | /: Regex (Ctrl+W to exit)\n ↑/↓: Navigate | Enter: Select" \
            "$(tput dim)$(tput smul)" "$(tput rmul)$(tput sgr0)${BOLD}"
    else
        printf "1: Cancel job | 2: SSH node | 3: Attach job | 4: Details | 9: Exit | /: Regex (Ctrl+W to exit)\n ↑/↓: Navigate | Enter: Select"
    fi
}

# Function to show job menu
show_job_menu() {
    local job="$1"
    IFS='|' read -r jobid partition name status time nodes nodelist <<< "$job"
    
    while true; do
        clear_screen
        
        # Draw title
        position_cursor 1 1
        printf "%sJob %s Actions%s\n\n" "$BOLD" "$jobid" "$RESET"
        
        # Draw job info
        printf "Name: %s\n" "$name"
        printf "Status: %s\n" "$status"
        printf "Nodes: %s\n\n" "$nodelist"
        
        # Draw menu options
        printf "1. Cancel job\n"
        printf "2. Show detailed info\n"
        printf "3. SSH to first node\n"
        printf "4. Watch job output\n"
        printf "5. Back to main menu\n"
        
        # Get user input
        read -rsn1 key
        case $key in
            1) scancel "$jobid"; break ;;
            2) scontrol show job "$jobid" | less ;;
            3) 
                if [ "$nodelist" != "(None)" ]; then
                    first_node=$(echo "$nodelist" | cut -d',' -f1)
                    ssh "$first_node"
                fi
                ;;
            4) tail -f "slurm-${jobid}.out" ;;
            5|9) break ;;
        esac
    done
}

# Function to setup terminal
setup_terminal() {
    # Enable interpretation of backslash escapes
    echo -e "\033[?1049h" # Use alternate screen buffer
    stty -echo            # Don't echo typed characters
    tput smcup           # Save screen
    tput civis          # Hide cursor
}

# Function to restore terminal
restore_terminal() {
    echo -e "\033[?25h"  # Show cursor
    tput cnorm          # Restore cursor
    tput rmcup          # Restore screen
    stty echo           # Restore echo
    stty sane           # Restore terminal settings
    echo -e "\033[?1049l" # Restore main screen buffer
    clear               # Clear the screen
}

# Function to handle interrupts
handle_interrupt() {
    restore_terminal
    exit 0
}

# Function to run commands safely
run_command() {
    local cmd="$1"
    restore_terminal
    trap handle_interrupt INT
    
    # Run the command
    if [[ "$cmd" == *"less"* ]]; then
        # For commands using less, we need to handle the pipe differently
        local jobid=$(echo "$cmd" | grep -o 'job [0-9]*' | awk '{print $2}')
        scontrol show job "$jobid" | less
    elif [[ "$cmd" == "sattach"* ]]; then
        # Special handling for sattach to catch Ctrl+C
        trap 'return 0' INT  # Make Ctrl+C just break the command
        $cmd
        trap handle_interrupt INT  # Restore Ctrl+C handler
    else
        # For other interactive commands (ssh), use direct execution
        $cmd
    fi
    
    setup_terminal
    # Restore both EXIT and INT traps
    trap restore_terminal EXIT
    trap handle_interrupt INT
    # Force an immediate refresh of the display
    get_jobs
    draw_menu
    last_update=$(date +%s)
}

# Function to confirm action
confirm_action() {
    local message="$1"
    # Clear the command area first
    position_cursor $((LINES-3)) 2
    printf "%$(($COLUMNS-4))s"    # Clear available commands line
    position_cursor $((LINES-2)) 2
    printf "%$(($COLUMNS-4))s"    # Clear commands line
    position_cursor $((LINES-1)) 2
    printf "%$(($COLUMNS-4))s"    # Clear any previous content
    
    # Show the prompt
    position_cursor $((LINES-2)) 2
    printf "%s%s (y/n/enter): %s" "$BOLD" "$message" "$RESET"
    
    # Get the answer
    while true; do
        read -rsn1 answer
        case "$answer" in
            y|Y|"") return 0 ;;
            n|N) return 1 ;;
        esac
    done
}

# Function to toggle job selection
toggle_selection() {
    local jobid="$1"
    if [[ " ${selected_jobs[@]} " =~ " ${jobid} " ]]; then
        # Remove from selection and create new array without empty elements
        local new_array=()
        for j in "${selected_jobs[@]}"; do
            if [[ $j != "$jobid" && -n "$j" ]]; then
                new_array+=("$j")
            fi
        done
        selected_jobs=("${new_array[@]}")
    else
        # Add to selection
        selected_jobs+=("$jobid")
    fi
}

# Function to select all jobs
select_all() {
    selected_jobs=()
    for job in "${jobs_data[@]}"; do
        IFS='|' read -r jobid _ _ _ _ _ _ <<< "$job"
        selected_jobs+=("$jobid")
    done
}

# Main loop
main() {
    # Setup terminal
    setup_terminal
    
    # Set interrupt and exit handlers
    trap restore_terminal EXIT  # Add EXIT trap
    trap handle_interrupt INT
    
    # Initialize variables
    local last_update=0
    local current_time=0
    local key=""
    local redraw_needed=1
    
    # Initialize selected_index to first job
    selected_index=0  # Changed from -1 to 0 to start on first job
    
    # Initialize filtered jobs
    filtered_jobs=("${jobs_data[@]}")
    
    while true; do
        # Only check time every 5 iterations
        ((update_counter++))
        if ((update_counter >= 5)); then
            current_time=$(date +%s)
            update_counter=0
            
            # Update jobs list every 3 seconds
            if ((current_time - last_update >= 3)); then
                if get_jobs; then  # Only redraw if jobs changed
                    redraw_needed=1
                fi
                last_update=$current_time
            fi
        fi
        
        # Only redraw if needed
        if ((redraw_needed)); then
            draw_menu
            redraw_needed=0
        fi
        
        # More efficient input handling
        if [ $filter_mode -eq 1 ]; then
            read -rsn1 -t 0.05 key
            if [[ $? -eq 0 ]]; then
                # Convert key to ASCII value for debugging
                key_ascii=$(printf "%d" "'$key")
                
                case $key in
                    $'\x1B')  # Escape or arrow keys
                        read -rsn2 -t 0.1 next_key
                        if [ $? -ne 0 ]; then  # If no more keys, it's Escape
                            filter_mode=0
                            entered_regex_with_down=0
                            filter_text=""  # Clear the regex
                            cursor_pos=0
                            if [ $entered_regex_with_down -eq 1 ]; then
                                selected_index=$((${#jobs_data[@]} - 1))
                            else
                                selected_index=0
                            fi
                            draw_menu
                            continue
                        fi
                        # Handle arrow keys
                        case $next_key in
                            "[D")  # Left arrow
                                if [ $cursor_pos -gt 0 ]; then
                                    ((cursor_pos--))
                                    draw_menu
                                fi
                                ;;
                            "[C")  # Right arrow
                                if [ $cursor_pos -lt ${#filter_text} ]; then
                                    ((cursor_pos++))
                                    draw_menu
                                fi
                                ;;
                            "[A")  # Up arrow
                                if [ $entered_regex_with_down -eq 1 ]; then
                                    filter_mode=0
                                    entered_regex_with_down=0
                                    filter_text=""
                                    cursor_pos=0
                                    selected_index=$((${#jobs_data[@]} - 1))
                                    draw_menu
                                fi
                                ;;
                            "[3")  # Delete key
                                read -rsn1 -t 0.1 _  # consume the "~"
                                if [ $cursor_pos -lt ${#filter_text} ]; then
                                    filter_text="${filter_text:0:$cursor_pos}${filter_text:$((cursor_pos+1))}"
                                    draw_menu
                                fi
                                ;;
                        esac
                        ;;
                    $'\x03')  # Ctrl+C
                        filter_mode=0
                        entered_regex_with_down=0
                        filter_text=""  # Clear the regex
                        cursor_pos=0
                        if [ $entered_regex_with_down -eq 1 ]; then
                            selected_index=$((${#jobs_data[@]} - 1))
                        else
                            selected_index=0
                        fi
                        draw_menu
                        continue
                        ;;
                    $'\x17'|$'\027')  # Ctrl+W (try both hex and octal)
                        filter_mode=0
                        entered_regex_with_down=0
                        filter_text=""  # Clear the regex
                        cursor_pos=0
                        if [ $entered_regex_with_down -eq 1 ]; then
                            selected_index=$((${#jobs_data[@]} - 1))
                        else
                            selected_index=0
                        fi
                        draw_menu
                        ;;
                    $'\x7f')  # Backspace
                        if [ $cursor_pos -gt 0 ]; then
                            filter_text="${filter_text:0:$((cursor_pos-1))}${filter_text:$cursor_pos}"
                            ((cursor_pos--))
                            draw_menu
                        fi
                        ;;
                    $'\x0d'|"")  # Enter key
                        # Add matching jobs to existing selection
                        if [ -n "$filter_text" ]; then
                            for job in "${jobs_data[@]}"; do
                                IFS='|' read -r jobid _ name _ _ _ _ <<< "$job"
                                # Only match against the job name
                                if [[ "$name" =~ $filter_text ]]; then
                                    # Only add if not already selected
                                    if [[ ! " ${selected_jobs[@]} " =~ " ${jobid} " ]]; then
                                        selected_jobs+=("$jobid")
                                    fi
                                fi
                            done
                        fi
                        entered_regex_with_down=0
                        filter_mode=0
                        filter_text=""
                        cursor_pos=0
                        selected_index=0
                        draw_menu
                        ;;
                    *)
                        if [[ $key =~ [[:print:]] ]]; then
                            # Insert character at cursor position
                            filter_text="${filter_text:0:$cursor_pos}$key${filter_text:$cursor_pos}"
                            ((cursor_pos++))
                            draw_menu
                        fi
                        ;;
                esac
                redraw_needed=1  # Set flag instead of calling draw_menu directly
            fi
        else
            # Normal mode input handling
            read -rsn1 -t 0.05 key  # Reduced timeout
            if [[ $? -eq 0 ]]; then
                case $key in
                    $'\x1B')  # Handle arrow keys
                        read -rsn2 -t 0.1 key
                        case $key in
                            "[A") # Up arrow
                                if [ $selected_index -gt -1 ]; then
                                    ((selected_index--))
                                    draw_menu
                                fi
                                ;;
                            "[B") # Down arrow
                                if [ $selected_index -lt $((${#jobs_data[@]} - 1)) ]; then
                                    ((selected_index++))
                                    draw_menu
                                else
                                    # Enter regex mode when pressing down at last job
                                    filter_mode=1
                                    entered_regex_with_down=1
                                    selected_index=${#jobs_data[@]}
                                    draw_menu
                                fi
                                ;;
                        esac
                        ;;
                    "")  # Enter key
                        if [ $selected_index -eq -1 ]; then
                            # Toggle all jobs
                            if are_all_jobs_selected; then
                                selected_jobs=()
                            else
                                select_all
                            fi
                        elif [ ${#jobs_data[@]} -gt 0 ]; then
                            local job="${jobs_data[$selected_index]}"
                            IFS='|' read -r jobid _ name _ _ _ _ <<< "$job"
                            toggle_selection "$jobid"
                        fi
                        draw_menu
                        ;;
                    1)
                        if [ ${#selected_jobs[@]} -gt 0 ]; then
                            if confirm_action "Are you sure you want to cancel ${#selected_jobs[@]} selected job(s)?"; then
                                for jobid in "${selected_jobs[@]}"; do
                                    run_command "scancel $jobid"
                                done
                                selected_jobs=()  # Clear selection after canceling
                            else
                                draw_menu
                            fi
                        elif [ ${#jobs_data[@]} -gt 0 ]; then
                            local job="${jobs_data[$selected_index]}"
                            IFS='|' read -r jobid _ name _ _ _ _ <<< "$job"
                            if confirm_action "Are you sure you want to cancel job '$name' ($jobid)?"; then
                                run_command "scancel $jobid"
                            else
                                draw_menu
                            fi
                        fi
                        ;;
                    2|3|4)
                        # Only process these commands if no jobs are selected
                        if [ ${#selected_jobs[@]} -eq 0 ] && [ ${#jobs_data[@]} -gt 0 ]; then
                            case $key in
                                2)
                                    local job="${jobs_data[$selected_index]}"
                                    IFS='|' read -r _ _ _ _ _ _ nodelist <<< "$job"
                                    if [ "$nodelist" != "(None)" ]; then
                                        first_node=$(echo "$nodelist" | cut -d',' -f1)
                                        run_command "ssh $first_node"
                                    fi
                                    ;;
                                3)
                                    local job="${jobs_data[$selected_index]}"
                                    IFS='|' read -r jobid _ _ _ _ _ _ <<< "$job"
                                    run_command "sattach ${jobid}.0"
                                    ;;
                                4)
                                    local job="${jobs_data[$selected_index]}"
                                    IFS='|' read -r jobid _ _ _ _ _ _ <<< "$job"
                                    run_command "scontrol show job $jobid | less"
                                    ;;
                            esac
                        fi
                        ;;
                    9) handle_interrupt ;;
                    "/")  # Add filter mode trigger
                        filter_mode=1
                        entered_regex_with_down=0  # Reset flag when entering with /
                        selected_index=0
                        draw_menu
                        ;;
                esac
                redraw_needed=1  # Set flag instead of calling draw_menu directly
            fi
        fi
    done
}

main 